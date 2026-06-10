const { verifyUser } = require('./_lib/auth');
const { serviceClient } = require('./_lib/supabase');

const ADMIN_USER_ID = process.env.TL_ADMIN_USER_ID || '';

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();

    // GET /api/profile?action=check-email — unauthenticated pre-login check
    if (req.method === 'GET' && req.query.action === 'check-email') {
        const email = (req.query.email || '').toLowerCase().trim();
        if (!email) return res.status(400).json({ ok: false, error: 'email required' });

        const [{ data: authData }, { data: invite }] = await Promise.all([
            serviceClient().auth.admin.listUsers({ perPage: 1000 }),
            serviceClient().from('tl_invites').select('id').eq('email', email).is('used_by', null).maybeSingle(),
        ]);

        const existing = (authData?.users || []).some(u => u.email?.toLowerCase() === email);
        if (existing) return res.json({ ok: true, status: 'existing' });
        if (invite) return res.json({ ok: true, status: 'invited' });
        return res.json({ ok: true, status: 'unknown' });
    }

    const user = await verifyUser(req);
    if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const isAdmin = ADMIN_USER_ID && user.id === ADMIN_USER_ID;

    // GET /api/profile — own profile
    if (req.method === 'GET' && !req.query.action) {
        const { data: profile } = await serviceClient()
            .from('tl_profiles')
            .select('approved, display_name')
            .eq('id', user.id)
            .single();

        if (profile?.approved !== true) {
            const { data: authUser } = await serviceClient().auth.admin.getUserById(user.id);
            const userEmail = authUser?.user?.email?.toLowerCase();
            if (userEmail) {
                const { data: invite } = await serviceClient()
                    .from('tl_invites')
                    .select('id')
                    .eq('email', userEmail)
                    .is('used_by', null)
                    .maybeSingle();
                if (invite) {
                    const displayName = user.user_metadata?.full_name || userEmail.split('@')[0];
                    await serviceClient()
                        .from('tl_profiles')
                        .upsert({ id: user.id, approved: true, display_name: displayName }, { onConflict: 'id' });
                    await serviceClient()
                        .from('tl_invites')
                        .update({ used_by: user.id, used_at: new Date().toISOString() })
                        .eq('id', invite.id);
                    return res.json({ ok: true, approved: true, display_name: displayName, is_admin: isAdmin });
                }
            }
        }

        return res.json({
            ok:           true,
            approved:     profile?.approved === true,
            display_name: profile?.display_name || user.user_metadata?.full_name || user.email,
            is_admin:     isAdmin,
        });
    }

    if (!isAdmin) return res.status(403).json({ ok: false, error: 'Forbidden' });

    // GET /api/profile?action=list
    if (req.method === 'GET' && req.query.action === 'list') {
        const [{ data: profiles }, { data: authData }, { data: storageRows, error: storageErr }] = await Promise.all([
            serviceClient().from('tl_profiles').select('id, display_name, approved, created_at').order('created_at'),
            serviceClient().auth.admin.listUsers({ perPage: 200 }),
            serviceClient().rpc('tl_storage_per_user'),
        ]);
        if (storageErr) console.error('[profile] storage rpc error:', storageErr);

        const emailMap = {};
        (authData?.users || []).forEach(u => { emailMap[u.id] = u.email; });

        const storageMap = {};
        (storageRows || []).forEach(r => { storageMap[r.user_id] = { activity_count: Number(r.activity_count), storage_bytes: Number(r.storage_bytes) }; });

        const users = (profiles || []).map(p => {
            const stats = storageMap[p.id] || { activity_count: 0, storage_bytes: 0 };
            return {
                user_id:        p.id,
                display_name:   p.display_name,
                email:          emailMap[p.id] || '',
                approved:       p.approved,
                created_at:     p.created_at,
                activity_count: stats.activity_count,
                storage_bytes:  stats.storage_bytes,
            };
        });

        return res.json({ ok: true, users });
    }

    // GET /api/profile?action=list-invites
    if (req.method === 'GET' && req.query.action === 'list-invites') {
        const { data: invites } = await serviceClient()
            .from('tl_invites')
            .select('id, email, created_at, used_by, used_at')
            .order('created_at', { ascending: false });

        const usedByIds = (invites || []).filter(i => i.used_by).map(i => i.used_by);
        let nameMap = {};
        if (usedByIds.length) {
            const { data: profiles } = await serviceClient()
                .from('tl_profiles')
                .select('id, display_name')
                .in('id', usedByIds);
            (profiles || []).forEach(p => { nameMap[p.id] = p.display_name; });
        }

        const result = (invites || []).map(i => ({
            id:           i.id,
            email:        i.email,
            created_at:   i.created_at,
            used:         !!i.used_by,
            used_by_name: i.used_by ? (nameMap[i.used_by] || 'unknown') : null,
            used_at:      i.used_at,
        }));

        return res.json({ ok: true, invites: result });
    }

    // POST actions (admin only)
    if (req.method === 'POST') {
        const { action, user_id, email } = req.body || {};

        if (action === 'approve') {
            if (!user_id) return res.status(400).json({ ok: false, error: 'user_id required' });
            const { error } = await serviceClient()
                .from('tl_profiles')
                .update({ approved: true })
                .eq('id', user_id);
            if (error) { console.error('[profile] approve error:', error); return res.status(500).json({ ok: false, error: 'db_error' }); }
            return res.json({ ok: true });
        }

        if (action === 'revoke') {
            if (!user_id) return res.status(400).json({ ok: false, error: 'user_id required' });
            const { error } = await serviceClient()
                .from('tl_profiles')
                .update({ approved: false })
                .eq('id', user_id);
            if (error) { console.error('[profile] revoke error:', error); return res.status(500).json({ ok: false, error: 'db_error' }); }
            return res.json({ ok: true });
        }

        if (action === 'delete-user') {
            if (!user_id) return res.status(400).json({ ok: false, error: 'user_id required' });
            if (user_id === ADMIN_USER_ID) return res.status(400).json({ ok: false, error: 'Cannot delete the admin account' });
            const { error } = await serviceClient().auth.admin.deleteUser(user_id);
            if (error) { console.error('[profile] delete-user error:', error); return res.status(500).json({ ok: false, error: 'db_error' }); }
            return res.json({ ok: true });
        }

        if (action === 'delete-invite') {
            const { invite_id } = req.body || {};
            if (!invite_id) return res.status(400).json({ ok: false, error: 'invite_id required' });
            const { error } = await serviceClient()
                .from('tl_invites')
                .delete()
                .eq('id', invite_id)
                .is('used_by', null);
            if (error) { console.error('[profile] delete-invite error:', error); return res.status(500).json({ ok: false, error: 'db_error' }); }
            return res.json({ ok: true });
        }

        if (action === 'create-invite') {
            if (!email) return res.status(400).json({ ok: false, error: 'email required' });
            const normalizedEmail = email.toLowerCase().trim();
            const { error: insertErr } = await serviceClient()
                .from('tl_invites')
                .insert({ email: normalizedEmail, created_by: user.id });
            if (insertErr) { console.error('[profile] create-invite error:', insertErr); return res.status(500).json({ ok: false, error: 'db_error' }); }

            const resendKey = process.env.RESEND_API_KEY;
            const appUrl = process.env.APP_URL || '';
            let emailStatus = 'no_key';
            if (resendKey) {
                try {
                    const ac = new AbortController();
                    const timer = setTimeout(() => ac.abort(), 10000);
                    const emailRes = await fetch('https://api.resend.com/emails', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
                        signal: ac.signal,
                        body: JSON.stringify({
                            from: 'CharlesLogic <noreply@charleslogic.com>',
                            to: [normalizedEmail],
                            subject: "You're invited to TrackLog",
                            html: `<p>You've been invited to <strong>TrackLog</strong> — a GPS activity viewer.</p>
<p><a href="${appUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:1.1em">Open TrackLog →</a></p>
<p style="color:#888;font-size:.9em;margin-top:16px">Sign in with this email address: <strong>${normalizedEmail}</strong></p>`,
                        }),
                    });
                    clearTimeout(timer);
                    emailStatus = emailRes.ok ? 'sent' : `error_${emailRes.status}`;
                } catch (e) {
                    emailStatus = 'fetch_error';
                }
            }

            return res.json({ ok: true, email_status: emailStatus });
        }

        return res.status(400).json({ ok: false, error: 'unknown action' });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
