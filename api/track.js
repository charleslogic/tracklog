const { verifyApprovedUser } = require('./_lib/auth');
const { serviceClient } = require('./_lib/supabase');

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const { user, approved } = await verifyApprovedUser(req);
    if (!user)     return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!approved) return res.status(403).json({ ok: false, error: 'pending_approval' });

    const id = req.query.id || '';
    if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });

    const { data, error } = await serviceClient()
        .from('tl_activities')
        .select('id, source_id, name, type, distance, total_time, moving_time, elev_gain, elev_loss, avg_speed, max_speed, avg_hr, max_hr, avg_cad, start_time, geo_points')
        .eq('id', id)
        .eq('user_id', user.id)
        .single();

    if (error || !data) return res.status(404).json({ ok: false, error: 'Not found' });

    return res.json({
        ok:          true,
        id:          data.id,
        source_id:   data.source_id,
        name:        data.name,
        type:        data.type,
        distance:    data.distance,
        total_time:  data.total_time,
        moving_time: data.moving_time,
        elev_gain:   data.elev_gain,
        elev_loss:   data.elev_loss,
        avg_speed:   data.avg_speed,
        max_speed:   data.max_speed,
        avg_hr:      data.avg_hr,
        max_hr:      data.max_hr,
        avg_cad:     data.avg_cad,
        start_time:  data.start_time,
        latlngs:     data.geo_points || [],
    });
};
