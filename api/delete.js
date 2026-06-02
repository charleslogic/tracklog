const { verifyApprovedUser } = require('./_lib/auth');
const { serviceClient } = require('./_lib/supabase');

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'DELETE' && req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const { user, approved } = await verifyApprovedUser(req);
    if (!user)     return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!approved) return res.status(403).json({ ok: false, error: 'pending_approval' });

    const id = req.query.id || req.body?.id || '';
    if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });

    const { error } = await serviceClient()
        .from('tl_activities')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id);

    if (error) { console.error('[delete] error:', error); return res.status(500).json({ ok: false, error: 'db_error' }); }

    return res.json({ ok: true });
};
