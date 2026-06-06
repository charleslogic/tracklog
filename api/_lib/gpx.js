// Server-side GPX parser — logic ported from index.html client code.
// Replaces DOMParser with fast-xml-parser for Node.js compatibility.
const { XMLParser } = require('fast-xml-parser');

const TYPE_MAP = {
    run:'run', running:'run', trailrun:'run', trailrunning:'run',
    hike:'hike', hiking:'hike',
    walk:'walk', walking:'walk',
    ride:'ride', cycling:'ride', bike:'ride', biking:'ride', bicycle:'ride',
    virtualride:'ride', gravelride:'ride', mountainbikeride:'ride',
    ebikeride:'ride', emountainbikeride:'ride', mountainbike:'ride',
    swim:'swim', swimming:'swim',
    ski:'ski', alpineski:'ski', backcountryski:'ski', nordicski:'ski',
    rollerski:'ski', snowboard:'ski', snowshoe:'ski', snowshoeing:'ski',
    skate:'skate', iceskate:'skate', inlineskate:'skate',
    kayak:'kayak', kayaking:'kayak', canoeing:'kayak', rowing:'kayak',
    paddling:'kayak', standuppaddling:'kayak',
    surf:'surf', surfing:'surf', windsurf:'surf', kitesurf:'surf',
    workout:'workout', weighttraining:'workout', yoga:'workout',
    crossfit:'workout', elliptical:'workout', stairstepper:'workout',
    fitness:'workout', gym:'workout',
    soccer:'sport', tennis:'sport', golf:'sport',
};

function mapType(raw) {
    if (!raw) return null;
    const key = String(raw).toLowerCase().replace(/[\s_-]+/g, '');
    return TYPE_MAP[key] || String(raw).toLowerCase();
}

function inferType(distM, durSec, elevGainM) {
    if (!distM || distM < 100 || !durSec || durSec < 60) return 'activity';
    const kph = (distM / 1000) / (durSec / 3600);
    if (kph < 1.5) return 'activity';
    if (kph < 4) return (elevGainM || 0) > 150 ? 'hike' : 'walk';
    if (kph < 13) return 'run';
    return 'ride';
}

function decimate(pts, max) {
    if (pts.length <= max) return pts;
    const result = []; const step = (pts.length - 1) / (max - 1);
    for (let i = 0; i < max; i++) result.push(pts[Math.round(i * step)]);
    return result;
}

function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function makeSourceId(filename, startTime, firstLat, firstLon) {
    const base = filename.replace(/\.(gpx|tcx)(\.gz)?$/i, '');
    if (/^\d{7,}$/.test(base)) return 'strava_' + base;
    if (/^route_/i.test(base)) return 'ah_' + base.toLowerCase();
    const t = startTime ? startTime.replace(/[^0-9T]/g, '').slice(0, 15) : '';
    const la = firstLat != null ? Math.round(firstLat * 1000) : '';
    const lo = firstLon != null ? Math.round(firstLon * 1000) : '';
    return `gpx_${t}_${la}_${lo}`;
}

// Returns source_id derivable from filename alone (only for Route_* and strava ID filenames).
// Returns null for generic filenames that need content to compute source_id.
function sourceIdFromFilename(filename) {
    const base = filename.replace(/\.(gpx|tcx)(\.gz)?$/i, '');
    if (/^\d{7,}$/.test(base)) return 'strava_' + base;
    if (/^route_/i.test(base)) return 'ah_' + base.toLowerCase();
    return null;
}

function findExtensions(obj, result) {
    if (!result) result = {};
    if (!obj || typeof obj !== 'object') return result;
    if (result.hr != null && result.cad != null) return result;
    for (const k of Object.keys(obj)) {
        const local = k.includes(':') ? k.split(':').pop() : k;
        if (local === 'hr'  && result.hr  == null) { const v = parseInt(obj[k]); if (!isNaN(v) && v > 0) result.hr  = v; }
        if (local === 'cad' && result.cad == null) { const v = parseInt(obj[k]); if (!isNaN(v) && v > 0) result.cad = v; }
        findExtensions(obj[k], result);
    }
    return result;
}

const XML_PARSER = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => name === 'trkpt' || name === 'trkseg' || name === 'trk' || name === 'Lap' || name === 'Trackpoint',
    parseAttributeValue: true,
    parseTagValue: true,
});

// Accepts a Buffer or string, returns the same activity object shape as api/import.js expects.
// Returns null if the GPX has fewer than 2 valid track points.
function parseGpxBuffer(bufferOrString, filename) {
    const xmlText = Buffer.isBuffer(bufferOrString) ? bufferOrString.toString('utf8') : bufferOrString;
    let doc;
    try { doc = XML_PARSER.parse(xmlText); } catch (e) { return null; }

    const gpx = doc.gpx || {};
    const trks = [].concat(gpx.trk || []);
    const trksegs = trks.flatMap(t => [].concat(t.trkseg || []));
    const trkpts = trksegs.flatMap(s => [].concat(s.trkpt || []));
    if (trkpts.length < 2) return null;

    const pts = []; const times = []; let firstTime = null, lastTime = null;
    for (const pt of trkpts) {
        const lat = parseFloat(pt['@_lat']), lon = parseFloat(pt['@_lon']);
        if (isNaN(lat) || isNaN(lon)) continue;
        const ele = typeof pt.ele === 'number' ? pt.ele : parseFloat(pt.ele);
        const time = pt.time ? String(pt.time) : null;
        if (!firstTime && time) firstTime = time;
        if (time) lastTime = time;
        const ext = pt.extensions ? findExtensions(pt.extensions) : {};
        const hr = (ext.hr != null) ? ext.hr : null;
        const cad = (ext.cad != null) ? ext.cad : null;
        pts.push([lat, lon, isNaN(ele) ? null : ele, ...(hr !== null || cad !== null ? [hr, cad] : [])]);
        times.push(time ? Date.parse(time) : null);
    }
    if (pts.length < 2) return null;

    const metaName = gpx.metadata?.name;
    const trkName = trks[0]?.name;
    const name = (trkName || metaName || '').toString().trim() || null;
    const startTime = firstTime || gpx.metadata?.time?.toString()?.trim() || null;
    const durSec = (firstTime && lastTime) ? Math.round((new Date(lastTime) - new Date(firstTime)) / 1000) : null;

    // Speed-filtered distance: skip GPS jumps (>10 m/s ~22 mph between kept points).
    // Falls back to 3 m min-distance when no timestamps in the file.
    const hasTs = times.some(t => t !== null);
    let distM = 0, lastKeptIdx = 0;
    for (let i = 1; i < pts.length; i++) {
        const d = haversineM(pts[lastKeptIdx][0], pts[lastKeptIdx][1], pts[i][0], pts[i][1]);
        if (hasTs && times[lastKeptIdx] !== null && times[i] !== null) {
            if (d < 1) continue;
            const dt = (times[i] - times[lastKeptIdx]) / 1000;
            if (dt > 0 && d / dt > 10) continue;
        } else {
            if (d < 3) continue;
        }
        distM += d;
        lastKeptIdx = i;
    }

    // Elevation: ignore step-changes smaller than 1 m to suppress GPS altitude noise.
    let elevGain = 0, elevLoss = 0;
    const eles = pts.map(p => p[2]).filter(e => e != null);
    let lastEle = eles[0];
    for (let i = 1; i < eles.length; i++) {
        const d = eles[i] - lastEle;
        if (Math.abs(d) >= 1) { if (d > 0) elevGain += d; else elevLoss += -d; lastEle = eles[i]; }
    }

    const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
    const bbox = { s: +Math.min(...lats).toFixed(4), w: +Math.min(...lons).toFixed(4), n: +Math.max(...lats).toFixed(4), e: +Math.max(...lons).toFixed(4) };

    const source_id = makeSourceId(filename, startTime, pts[0][0], pts[0][1]);

    return {
        source_id,
        name: name || filename.replace(/\.(gpx)(\.gz)?$/i, '').replace(/[_-]/g, ' '),
        start_time: startTime,
        distance: +distM.toFixed(1),
        total_time: durSec,
        moving_time: durSec,
        elev_gain: eles.length > 1 ? +elevGain.toFixed(1) : null,
        elev_loss: eles.length > 1 ? +elevLoss.toFixed(1) : null,
        avg_speed: (durSec && durSec > 0) ? +(distM / durSec).toFixed(4) : null,
        max_speed: null,
        bbox_s: bbox.s, bbox_w: bbox.w, bbox_n: bbox.n, bbox_e: bbox.e,
        geo_points: decimate(pts, 50),
        // internal helpers for type inference — caller should delete before storing
        _d: distM, _t: durSec, _g: elevGain,
    };
}

function parseTcxBuffer(bufferOrString, filename) {
    const xmlText = Buffer.isBuffer(bufferOrString) ? bufferOrString.toString('utf8') : bufferOrString;
    let doc;
    try { doc = XML_PARSER.parse(xmlText); } catch (e) { return null; }

    const tcd = doc.TrainingCenterDatabase || {};
    const activityList = [].concat((tcd.Activities || {}).Activity || []);
    if (!activityList.length) return null;
    const activity = activityList[0];

    const sport = activity['@_Sport'] || '';
    const startTime = activity.Id ? String(activity.Id) : null;
    const laps = [].concat(activity.Lap || []);
    if (!laps.length) return null;

    // Lap-level aggregate stats
    let distM = 0, totalTimeSec = 0, maxSpd = 0;
    let sumAvgHr = 0, hrCount = 0, maxHr = 0, sumCad = 0, cadCount = 0;
    for (const lap of laps) {
        const d = typeof lap.DistanceMeters === 'number' ? lap.DistanceMeters : parseFloat(lap.DistanceMeters);
        const t = typeof lap.TotalTimeSeconds === 'number' ? lap.TotalTimeSeconds : parseFloat(lap.TotalTimeSeconds);
        const spd = typeof lap.MaximumSpeed === 'number' ? lap.MaximumSpeed : parseFloat(lap.MaximumSpeed);
        const avgHr = lap.AverageHeartRateBpm?.Value || 0;
        const mxHr = lap.MaximumHeartRateBpm?.Value || 0;
        const cad = lap.Cadence || 0;
        if (!isNaN(d)) distM += d;
        if (!isNaN(t)) totalTimeSec += t;
        if (!isNaN(spd) && spd > maxSpd) maxSpd = spd;
        if (avgHr > 0) { sumAvgHr += avgHr; hrCount++; }
        if (mxHr > maxHr) maxHr = mxHr;
        if (cad > 0) { sumCad += cad; cadCount++; }
    }

    // Collect all trackpoints across all laps
    const allTrkpts = laps.flatMap(lap => [].concat((lap.Track || {}).Trackpoint || []));
    if (allTrkpts.length < 2) return null;

    const pts = []; const times = []; let firstTime = null, lastTime = null;
    for (const tp of allTrkpts) {
        const pos = tp.Position || {};
        const lat = typeof pos.LatitudeDegrees === 'number' ? pos.LatitudeDegrees : parseFloat(pos.LatitudeDegrees);
        const lon = typeof pos.LongitudeDegrees === 'number' ? pos.LongitudeDegrees : parseFloat(pos.LongitudeDegrees);
        if (isNaN(lat) || isNaN(lon)) continue;
        const ele = typeof tp.AltitudeMeters === 'number' ? tp.AltitudeMeters : parseFloat(tp.AltitudeMeters);
        const time = tp.Time ? String(tp.Time) : null;
        if (!firstTime && time) firstTime = time;
        if (time) lastTime = time;
        const hr = tp.HeartRateBpm?.Value || null;
        const cad = tp.Cadence || null;
        pts.push([lat, lon, isNaN(ele) ? null : ele, ...(hr !== null || cad !== null ? [hr, cad] : [])]);
        times.push(time ? Date.parse(time) : null);
    }
    if (pts.length < 2) return null;

    const durSec = totalTimeSec > 0 ? Math.round(totalTimeSec)
        : (firstTime && lastTime ? Math.round((new Date(lastTime) - new Date(firstTime)) / 1000) : null);

    // Elevation: ignore step-changes smaller than 1 m to suppress GPS altitude noise.
    let elevGain = 0, elevLoss = 0;
    const eles = pts.map(p => p[2]).filter(e => e != null);
    let lastEle = eles[0];
    for (let i = 1; i < eles.length; i++) {
        const d = eles[i] - lastEle;
        if (Math.abs(d) >= 1) { if (d > 0) elevGain += d; else elevLoss += -d; lastEle = eles[i]; }
    }

    const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
    const bbox = { s: +Math.min(...lats).toFixed(4), w: +Math.min(...lons).toFixed(4), n: +Math.max(...lats).toFixed(4), e: +Math.max(...lons).toFixed(4) };
    const st = startTime || firstTime;

    return {
        source_id: makeSourceId(filename, st, pts[0][0], pts[0][1]),
        name: filename.replace(/\.tcx(\.gz)?$/i, '').replace(/[_-]/g, ' '),
        start_time: st,
        distance: +distM.toFixed(1),
        total_time: durSec,
        moving_time: durSec,
        elev_gain: eles.length > 1 ? +elevGain.toFixed(1) : null,
        elev_loss: eles.length > 1 ? +elevLoss.toFixed(1) : null,
        avg_speed: (durSec && durSec > 0) ? +(distM / durSec).toFixed(4) : null,
        max_speed: maxSpd > 0 ? +maxSpd.toFixed(4) : null,
        avg_hr: hrCount > 0 ? Math.round(sumAvgHr / hrCount) : null,
        max_hr: maxHr > 0 ? maxHr : null,
        avg_cad: cadCount > 0 ? Math.round(sumCad / cadCount) : null,
        geo_points: decimate(pts, 50),
        bbox_s: bbox.s, bbox_w: bbox.w, bbox_n: bbox.n, bbox_e: bbox.e,
        _d: distM, _t: durSec, _g: elevGain,
        _sport: mapType(sport),
    };
}

module.exports = { parseGpxBuffer, parseTcxBuffer, sourceIdFromFilename, inferType, mapType };
