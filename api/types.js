const { verifyApprovedUser } = require('./_lib/auth');
const { serviceClient }      = require('./_lib/supabase');

const NAMED_COLORS = {
    run:     '#ef4444',
    hike:    '#22c55e',
    walk:    '#84cc16',
    ride:    '#3b82f6',
    cycling: '#3b82f6',
    swim:    '#06b6d4',
    ski:     '#818cf8',
    skate:   '#a78bfa',
    kayak:   '#0ea5e9',
    surf:    '#38bdf8',
    workout: '#f59e0b',
    sport:   '#fb923c',
};

const PALETTE = ['#e05a2b', '#a82bd4', '#d42b6a', '#2bc4c0', '#d4a017', '#6d28d9'];

function typeColor(type) {
    if (NAMED_COLORS[type]) return NAMED_COLORS[type];
    let h = 0;
    for (const c of String(type)) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
    return PALETTE[h % PALETTE.length];
}

const COLD_START = new Date().toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const { user, approved } = await verifyApprovedUser(req);
    if (!user)     return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!approved) return res.status(403).json({ ok: false, error: 'pending_approval' });

    const { data, error } = await serviceClient()
        .rpc('tl_distinct_activity_types', { p_user_id: user.id });
    if (error) { console.error('[types] rpc error:', error); return res.status(500).json({ ok: false, error: 'db_error' }); }

    const types = (data || []).map(r => r.type);
    const result = {};
    types.forEach(t => { result[t] = { color: typeColor(t) }; });

    const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
    const version = sha ? `build ${sha}` : COLD_START;
    if (version) res.setHeader('X-App-Version', version);
    return res.json(result);
};
