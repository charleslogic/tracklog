const { verifyApprovedUser } = require('./_lib/auth');
const { serviceClient } = require('./_lib/supabase');

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    const { user, approved } = await verifyApprovedUser(req);
    if (!user)     return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!approved) return res.status(403).json({ ok: false, error: 'pending_approval' });

    const { activities } = req.body || {};
    if (!Array.isArray(activities) || activities.length === 0) {
        return res.status(400).json({ ok: false, error: 'activities array required' });
    }
    if (activities.length > 50) {
        return res.status(400).json({ ok: false, error: 'max 50 per batch' });
    }

    const records = activities.map(a => ({
        user_id:     user.id,
        source:      String(a.source || 'gpx').slice(0, 32),
        source_id:   a.source_id ? String(a.source_id).slice(0, 128) : null,
        name:        a.name     ? String(a.name).slice(0, 255) : null,
        type:        String(a.type || 'activity').slice(0, 64),
        distance:    typeof a.distance    === 'number' ? a.distance    : null,
        total_time:  typeof a.total_time  === 'number' ? Math.round(a.total_time)  : null,
        moving_time: typeof a.moving_time === 'number' ? Math.round(a.moving_time) : null,
        elev_gain:   typeof a.elev_gain   === 'number' ? a.elev_gain   : null,
        elev_loss:   typeof a.elev_loss   === 'number' ? a.elev_loss   : null,
        avg_speed:   typeof a.avg_speed   === 'number' ? +a.avg_speed.toFixed(4) : null,
        max_speed:   typeof a.max_speed   === 'number' ? a.max_speed   : null,
        avg_hr:      typeof a.avg_hr      === 'number' ? Math.round(a.avg_hr)    : null,
        max_hr:      typeof a.max_hr      === 'number' ? Math.round(a.max_hr)    : null,
        avg_cad:     typeof a.avg_cad     === 'number' ? Math.round(a.avg_cad)   : null,
        start_time:  a.start_time || null,
        bbox_s:      typeof a.bbox_s === 'number' ? +a.bbox_s.toFixed(4) : null,
        bbox_w:      typeof a.bbox_w === 'number' ? +a.bbox_w.toFixed(4) : null,
        bbox_n:      typeof a.bbox_n === 'number' ? +a.bbox_n.toFixed(4) : null,
        bbox_e:      typeof a.bbox_e === 'number' ? +a.bbox_e.toFixed(4) : null,
        geo_points:  Array.isArray(a.geo_points) ? a.geo_points : null,
    }));

    // Activities with source_id upsert (update on conflict); null source_id always inserts.
    const withId    = records.filter(r => r.source_id !== null);
    const withoutId = records.filter(r => r.source_id === null);

    let count = 0;

    if (withId.length) {
        const { error, data } = await serviceClient()
            .from('tl_activities')
            .upsert(withId, { onConflict: 'user_id,source_id', ignoreDuplicates: false })
            .select('id');
        if (error) { console.error('[import] upsert error:', error.message, error.code, error.details); return res.status(500).json({ ok: false, error: error.message || 'db_error' }); }
        count += (data || []).length;
    }

    if (withoutId.length) {
        const { error, data } = await serviceClient()
            .from('tl_activities')
            .insert(withoutId)
            .select('id');
        if (error) { console.error('[import] insert error:', error.message, error.code, error.details); return res.status(500).json({ ok: false, error: error.message || 'db_error' }); }
        count += (data || []).length;
    }

    return res.json({ ok: true, count });
};
