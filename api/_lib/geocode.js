// Reverse geocoding via Nominatim (free, no key) — server-side counterpart to
// geocodeLatLon() in index.html, used by the Dropbox auto-sync so synced
// activities get a "City, ST" location like manually-imported ones.
const _geoCache = {};
let _geoLastFetch = 0;
// Serialize every lookup through one promise chain. A webhook can sync several
// users concurrently (Promise.all), and a shared _geoLastFetch timestamp alone
// races — two callers read the same value and fire together, breaching Nominatim's
// 1 req/sec policy. Chaining guarantees one in-flight request at a time.
let _geoQueue = Promise.resolve();

async function _fetchGeo(key, lat, lon) {
    if (key in _geoCache) return _geoCache[key];

    const wait = Math.max(0, 1100 - (Date.now() - _geoLastFetch));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _geoLastFetch = Date.now();

    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&format=json&zoom=10`;
    try {
        const r = await fetch(url, { headers: { 'User-Agent': 'TrackLog (https://tracks.charleslogic.com)' } });
        if (!r.ok) { _geoCache[key] = null; return null; }
        const d = await r.json();
        const a = d.address || {};
        const city = a.city || a.town || a.village || a.county || '';
        const stCode = (a['ISO3166-2-lvl4'] || '').split('-').pop() || a.state || '';
        const loc = [city, stCode].filter(Boolean).join(', ') || null;
        _geoCache[key] = loc;
        return loc;
    } catch {
        _geoCache[key] = null;
        return null;
    }
}

async function geocodeLatLon(lat, lon) {
    const key = `${Math.round(lat * 10) / 10}_${Math.round(lon * 10) / 10}`;
    if (key in _geoCache) return _geoCache[key];
    const run = _geoQueue.then(() => _fetchGeo(key, lat, lon));
    _geoQueue = run.then(() => {}, () => {}); // keep the chain alive regardless of outcome
    return run;
}

module.exports = { geocodeLatLon };
