const crypto = require('crypto');
const { verifyUser } = require('./_lib/auth');
const { serviceClient } = require('./_lib/supabase');
const { parseGpxBuffer, parseTcxBuffer, sourceIdFromFilename, inferType, typeFromFilename } = require('./_lib/gpx');
const { geocodeLatLon } = require('./_lib/geocode');

const APP_KEY    = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const APP_URL    = process.env.APP_URL || '';
const REDIRECT   = APP_URL + '/api/dropbox?action=callback';
const FOLDER     = '/Apps/HealthFitExporter';

// ── HMAC helpers ──────────────────────────────────────────────────────────────

function hmacSha256Hex(data, secret) {
    return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// Constant-time comparison of two hex digests to avoid leaking byte-match timing.
function timingSafeHexEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function signState(uid) {
    const payload = Buffer.from(JSON.stringify({ uid, ts: Date.now() })).toString('base64url');
    const sig = hmacSha256Hex(payload, APP_SECRET);
    return `${payload}.${sig}`;
}

function verifyState(state) {
    const dot = state.lastIndexOf('.');
    if (dot < 0) return null;
    const payload = state.slice(0, dot), sig = state.slice(dot + 1);
    if (!timingSafeHexEqual(hmacSha256Hex(payload, APP_SECRET), sig)) return null;
    try {
        const { uid, ts } = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (Date.now() - ts > 10 * 60 * 1000) return null; // 10 min window
        return uid;
    } catch { return null; }
}

// ── Dropbox API helpers ───────────────────────────────────────────────────────

async function dbxPost(url, token, body) {
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`Dropbox ${url} → ${r.status}: ${t}`); }
    return r.json();
}

async function dbxDownload(pathLower, token) {
    const r = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Dropbox-API-Arg': JSON.stringify({ path: pathLower }),
        },
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`download ${pathLower} → ${r.status}: ${t}`); }
    return Buffer.from(await r.arrayBuffer());
}

async function exchangeCode(code) {
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT, client_id: APP_KEY, client_secret: APP_SECRET }),
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`token exchange → ${r.status}: ${t}`); }
    return r.json();
}

async function refreshAccessToken(userId, row) {
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token, client_id: APP_KEY, client_secret: APP_SECRET }),
    });
    if (!r.ok) throw new Error('token refresh failed');
    const d = await r.json();
    const expires_at = new Date(Date.now() + (d.expires_in || 14400) * 1000).toISOString();
    await serviceClient().from('tl_dropbox_tokens').update({ access_token: d.access_token, expires_at }).eq('user_id', userId);
    return d.access_token;
}

async function getValidToken(userId) {
    const { data, error } = await serviceClient().from('tl_dropbox_tokens').select('*').eq('user_id', userId).single();
    if (error || !data?.access_token) return null;
    if (data.expires_at && new Date(data.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
        return await refreshAccessToken(userId, data);
    }
    return data.access_token;
}

// ── Sync logic (shared by webhook + manual sync) ──────────────────────────────

async function syncForUser(userId) {
    const token = await getValidToken(userId);
    if (!token) throw new Error('no_token');

    const { data: tokenRow } = await serviceClient().from('tl_dropbox_tokens').select('folder_path').eq('user_id', userId).single();
    const folderPath = tokenRow?.folder_path || FOLDER;

    // List all .gpx files in folder
    let entries = [];
    let cursor = null;
    do {
        const body = cursor
            ? await dbxPost('https://api.dropboxapi.com/2/files/list_folder/continue', token, { cursor })
            : await dbxPost('https://api.dropboxapi.com/2/files/list_folder', token, { path: folderPath, limit: 2000 });
        entries = entries.concat((body.entries || []).filter(e => e['.tag'] === 'file' && /\.(gpx|tcx)(\.gz)?$/i.test(e.name)));
        cursor = body.has_more ? body.cursor : null;
    } while (cursor);

    if (!entries.length) return { imported: 0 };

    // Pre-filter Route_* entries by source_id (no download needed)
    const knownSourceIds = new Set();
    const routeEntries = entries.filter(e => sourceIdFromFilename(e.name) !== null);
    const otherEntries = entries.filter(e => sourceIdFromFilename(e.name) === null);

    if (routeEntries.length) {
        const candidates = routeEntries.map(e => sourceIdFromFilename(e.name));
        const { data: existing } = await serviceClient()
            .from('tl_activities')
            .select('source_id')
            .eq('user_id', userId)
            .in('source_id', candidates);
        (existing || []).forEach(r => knownSourceIds.add(r.source_id));
    }

    const toProcess = [
        ...routeEntries.filter(e => !knownSourceIds.has(sourceIdFromFilename(e.name))),
        ...otherEntries,
    ];

    let imported = 0;
    for (const entry of toProcess) {
        try {
            const buf = await dbxDownload(entry.path_lower, token);
            const isTcx = /\.tcx(\.gz)?$/i.test(entry.name);
            const parsed = isTcx ? parseTcxBuffer(buf, entry.name) : parseGpxBuffer(buf, entry.name);
            if (!parsed) continue;

            parsed.source = 'dropbox';
            parsed.type = parsed._sport || typeFromFilename(entry.name) || inferType(parsed._d, parsed._t, parsed._g);
            delete parsed._d; delete parsed._t; delete parsed._g; delete parsed._sport;

            const pt0 = Array.isArray(parsed.geo_points) ? parsed.geo_points[0] : null;
            const location = pt0 ? await geocodeLatLon(pt0[0], pt0[1]) : null;

            const record = {
                user_id:     userId,
                source:      parsed.source,
                source_id:   parsed.source_id || null,
                name:        parsed.name ? String(parsed.name).slice(0, 255) : null,
                type:        String(parsed.type || 'activity').slice(0, 64),
                distance:    typeof parsed.distance    === 'number' ? parsed.distance    : null,
                total_time:  typeof parsed.total_time  === 'number' ? Math.round(parsed.total_time)  : null,
                moving_time: typeof parsed.moving_time === 'number' ? Math.round(parsed.moving_time) : null,
                elev_gain:   typeof parsed.elev_gain   === 'number' ? parsed.elev_gain   : null,
                elev_loss:   typeof parsed.elev_loss   === 'number' ? parsed.elev_loss   : null,
                avg_speed:   typeof parsed.avg_speed   === 'number' ? +parsed.avg_speed.toFixed(4) : null,
                max_speed:   null,
                start_time:  parsed.start_time || null,
                bbox_s:      typeof parsed.bbox_s === 'number' ? +parsed.bbox_s.toFixed(4) : null,
                bbox_w:      typeof parsed.bbox_w === 'number' ? +parsed.bbox_w.toFixed(4) : null,
                bbox_n:      typeof parsed.bbox_n === 'number' ? +parsed.bbox_n.toFixed(4) : null,
                bbox_e:      typeof parsed.bbox_e === 'number' ? +parsed.bbox_e.toFixed(4) : null,
                geo_points:  Array.isArray(parsed.geo_points) ? parsed.geo_points : null,
                location,
            };

            if (record.source_id) {
                const { error } = await serviceClient().from('tl_activities').upsert(record, { onConflict: 'user_id,source_id', ignoreDuplicates: false });
                if (!error) imported++;
            } else {
                const { error } = await serviceClient().from('tl_activities').insert(record);
                if (!error) imported++;
            }
        } catch (e) {
            console.error(`[dropbox:sync] skipped ${entry.name}:`, e.message);
        }
    }

    return { imported };
}

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    // Read raw body once — needed for HMAC verification on webhook POST.
    // Parse JSON for all other POST routes that need it.
    const rawBodyBuf = await readRawBody(req);
    const rawBodyStr = rawBodyBuf.toString('utf8');
    let parsedBody = {};
    if (rawBodyStr) { try { parsedBody = JSON.parse(rawBodyStr); } catch {} }

    const action = req.query.action;

    // GET ?challenge=X — Dropbox webhook verification (no auth)
    if (req.method === 'GET' && req.query.challenge) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(req.query.challenge);
    }

    // GET ?action=status — connection status for current user
    if (req.method === 'GET' && action === 'status') {
        const user = await verifyUser(req);
        if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        const { data } = await serviceClient().from('tl_dropbox_tokens').select('dropbox_account_id, folder_path, expires_at').eq('user_id', user.id).single();
        return res.json({ ok: true, connected: !!(data?.dropbox_account_id), folder_path: data?.folder_path || FOLDER });
    }

    // GET ?action=auth — return Dropbox OAuth URL
    if (req.method === 'GET' && action === 'auth') {
        const user = await verifyUser(req);
        if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        if (!APP_KEY) return res.status(500).json({ ok: false, error: 'Dropbox not configured' });
        const state = signState(user.id);
        const params = new URLSearchParams({
            client_id: APP_KEY,
            redirect_uri: REDIRECT,
            response_type: 'code',
            token_access_type: 'offline',
            state,
        });
        return res.json({ ok: true, url: `https://www.dropbox.com/oauth2/authorize?${params}` });
    }

    // GET ?action=callback — OAuth code exchange (no auth, Dropbox redirect)
    if (req.method === 'GET' && action === 'callback') {
        const { code, state, error: oauthError } = req.query;
        if (oauthError) return res.redirect(302, APP_URL + '?dropbox_error=' + encodeURIComponent(oauthError));

        const uid = verifyState(state || '');
        if (!uid) return res.status(400).send('Invalid state');
        if (!code) return res.status(400).send('Missing code');

        try {
            const tokens = await exchangeCode(code);
            const accountInfo = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${tokens.access_token}` },
            }).then(r => r.json());

            const expires_at = new Date(Date.now() + (tokens.expires_in || 14400) * 1000).toISOString();
            await serviceClient().from('tl_dropbox_tokens').upsert({
                user_id: uid,
                dropbox_account_id: accountInfo.account_id || tokens.account_id,
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                expires_at,
                folder_path: FOLDER,
            }, { onConflict: 'user_id' });
        } catch (e) {
            console.error('[dropbox:callback]', e.message);
            return res.redirect(302, APP_URL + '?dropbox_error=auth_failed');
        }

        return res.redirect(302, APP_URL + '?dropbox_connected=1');
    }

    // POST ?action=sync — manual sync
    if (req.method === 'POST' && action === 'sync') {
        const user = await verifyUser(req);
        if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        try {
            const result = await syncForUser(user.id);
            return res.json({ ok: true, ...result });
        } catch (e) {
            if (e.message === 'no_token') return res.status(400).json({ ok: false, error: 'Dropbox not connected' });
            console.error('[dropbox:sync]', e.message);
            return res.status(500).json({ ok: false, error: e.message });
        }
    }

    // POST ?action=disconnect
    if (req.method === 'POST' && action === 'disconnect') {
        const user = await verifyUser(req);
        if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
        await serviceClient().from('tl_dropbox_tokens').delete().eq('user_id', user.id);
        return res.json({ ok: true });
    }

    // POST (no action) — Dropbox webhook notification
    if (req.method === 'POST' && !action) {
        // Verify HMAC signature against the raw body bytes
        const sig = req.headers['x-dropbox-signature'];
        const expected = hmacSha256Hex(rawBodyStr, APP_SECRET);
        if (!timingSafeHexEqual(expected, sig)) return res.status(403).json({ ok: false });

        // Sync all notified accounts before responding — Vercel terminates the function
        // after the response is sent, so fire-and-forget doesn't work here.
        // Dropbox allows up to 10s; syncing 1-2 new files is well within that.
        const accounts = parsedBody?.list_folder?.accounts || [];
        await Promise.all(accounts.map(async accountId => {
            const { data: rows } = await serviceClient()
                .from('tl_dropbox_tokens')
                .select('user_id')
                .eq('dropbox_account_id', accountId);
            await Promise.all((rows || []).map(row =>
                syncForUser(row.user_id).catch(e => console.error(`[dropbox:webhook] ${row.user_id}:`, e.message))
            ));
        }));

        return res.status(200).json({ ok: true });
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
};

// Disable Vercel's automatic body parsing so we can read the raw bytes for HMAC
// verification. Must be set AFTER the handler is assigned to module.exports above —
// otherwise the reassignment discards this property and bodyParser stays enabled.
module.exports.config = { api: { bodyParser: false } };
