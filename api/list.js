const { verifyApprovedUser } = require('./_lib/auth');
const { serviceClient } = require('./_lib/supabase');

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const t0 = Date.now();
    const { user, approved } = await verifyApprovedUser(req);
    if (!user)     return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!approved) return res.status(403).json({ ok: false, error: 'pending_approval' });

    const { from, to, all, bbox, limit } = req.query;
    const hardLimit = limit ? Math.min(parseInt(limit) || 99999, 99999) : 99999;

    function buildQuery() {
        let q = serviceClient()
            .from('tl_activities')
            .select('id, source_id, name, type, distance, total_time, moving_time, elev_gain, elev_loss, avg_speed, max_speed, location, start_time, bbox_s, bbox_w, bbox_n, bbox_e')
            .eq('user_id', user.id)
            .order('start_time', { ascending: false });

        if (bbox) {
            const [minLat, minLon, maxLat, maxLon] = bbox.split(',').map(Number);
            q = q.lte('bbox_s', maxLat).gte('bbox_n', minLat)
                 .lte('bbox_w', maxLon).gte('bbox_e', minLon);
        } else if (!all) {
            if (from) q = q.gte('start_time', from);
            if (to)   q = q.lte('start_time', to + 'T23:59:59Z');
        }
        return q;
    }

    const PAGE = 1000;
    let offset = 0;
    let allData = [];
    while (allData.length < hardLimit) {
        const pageSize = Math.min(PAGE, hardLimit - allData.length);
        const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
        if (error) { console.error('[list] query error:', error); return res.status(500).json({ ok: false, error: 'db_error' }); }
        allData.push(...(data || []));
        if ((data || []).length < pageSize) break;
        offset += pageSize;
    }

    const tracks = allData.map(r => ({
        id:          r.id,
        source_id:   r.source_id,
        name:        r.name,
        type:        r.type,
        distance:    r.distance,
        total_time:  r.total_time,
        moving_time: r.moving_time,
        elev_gain:   r.elev_gain,
        elev_loss:   r.elev_loss,
        avg_speed:   r.avg_speed,
        max_speed:   r.max_speed,
        location:    r.location,
        start_time:  r.start_time,
        bbox: [r.bbox_s, r.bbox_w, r.bbox_n, r.bbox_e],
    }));

    res.setHeader('X-Server-Ms', String(Date.now() - t0));
    return res.json({ ok: true, tracks, total_count: tracks.length });
};
