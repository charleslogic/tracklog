#!/usr/bin/env node
// Compare two TrackLog accounts' tl_activities to detect drift between a long-lived
// (prod) account that accumulates state through continuous upserts and a freshly
// wiped+reimported (test) control account seeded from the *same* source files.
//
// Because both accounts ingest identical sources through identical import code,
// source_id matches 1:1 between them, so any field difference on a matched source_id
// is a real drift signal. See scripts/README.md.
//
// Usage:
//   node scripts/compare-accounts.js <prodEmailOrId> <testEmailOrId> [--out <path>] [--summary-only]
//   --summary-only prints the counts only and skips writing the JSON report.
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Exit code: 0 if no HARD diffs and no orphans; 1 if any; 2 on usage/config error.

const fs = require('fs');

function die(msg) { console.error('ERROR: ' + msg); process.exit(2); }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Field classification ────────────────────────────────────────────────────────
// HARD = a difference means real drift to investigate. SOFT = may legitimately
// differ (import-lane label / geocode timing); reported but does not fail the run.
const HARD_STR   = ['name', 'type'];
const HARD_INT   = ['total_time', 'moving_time', 'avg_hr', 'max_hr', 'avg_cad'];
const HARD_FLOAT = { distance: 0.05, elev_gain: 0.05, elev_loss: 0.05, avg_speed: 0.05, max_speed: 0.05,
                     bbox_s: 1e-4, bbox_w: 1e-4, bbox_n: 1e-4, bbox_e: 1e-4 };
const SOFT       = ['source', 'location'];

const COLUMNS = 'id, user_id, source, source_id, name, type, distance, total_time, moving_time, ' +
                'elev_gain, elev_loss, avg_speed, max_speed, avg_hr, max_hr, avg_cad, location, ' +
                'start_time, bbox_s, bbox_w, bbox_n, bbox_e, geo_points, created_at';

// ── Helpers ──────────────────────────────────────────────────────────────────
async function resolveUser(sb, ref) {
    if (UUID_RE.test(ref)) return { id: ref, label: ref };
    let page = 1;
    for (;;) {
        const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) die(`listUsers failed: ${error.message}`);
        const users = data?.users || [];
        const hit = users.find(u => (u.email || '').toLowerCase() === ref.toLowerCase());
        if (hit) return { id: hit.id, label: ref };
        if (users.length < 1000) break;
        page++;
    }
    die(`No user found for "${ref}". Pass an email that exists, or a raw user UUID.`);
}

async function fetchActivities(sb, userId) {
    const PAGE = 1000;
    let offset = 0, all = [];
    for (;;) {
        const { data, error } = await sb
            .from('tl_activities')
            .select(COLUMNS)
            .eq('user_id', userId)
            .order('source_id', { ascending: true })
            .order('id', { ascending: true })
            .range(offset, offset + PAGE - 1);
        if (error) die(`fetch failed for ${userId}: ${error.message}`);
        all.push(...(data || []));
        if ((data || []).length < PAGE) break;
        offset += PAGE;
    }
    return all;
}

function indexBySourceId(rows) {
    const map = new Map(), nullId = [], dupes = [];
    for (const r of rows) {
        if (r.source_id == null) { nullId.push(r); continue; }
        if (map.has(r.source_id)) dupes.push(r.source_id);
        else map.set(r.source_id, r);
    }
    return { map, nullId, dupes };
}

const cmpExact = (a, b) => (a == null && b == null) ? true : a === b;
const cmpFloat = (a, b, eps) => (a == null && b == null) ? true : (a == null || b == null) ? false : Math.abs(a - b) <= eps;
const cmpTime  = (a, b) => (a == null && b == null) ? true : (a == null || b == null) ? false : Date.parse(a) === Date.parse(b);

function cmpGeo(a, b) {
    a = Array.isArray(a) ? a : [];
    b = Array.isArray(b) ? b : [];
    if (a.length !== b.length) return { equal: false, reason: `point count ${a.length} vs ${b.length}`, diffPoints: a.length + b.length, samples: [] };
    let diff = 0; const samples = [];
    for (let i = 0; i < a.length; i++) {
        const pa = a[i] || [], pb = b[i] || [];
        let bad = false;
        if ((pa.length || 0) !== (pb.length || 0)) bad = true;          // 3-slot vs 5-slot drift
        else if (!cmpFloat(pa[0], pb[0], 1e-6)) bad = true;             // lat
        else if (!cmpFloat(pa[1], pb[1], 1e-6)) bad = true;             // lon
        else if (!cmpFloat(pa[2] ?? null, pb[2] ?? null, 0.5)) bad = true; // ele
        else if (!cmpExact(pa[3] ?? null, pb[3] ?? null)) bad = true;   // hr
        else if (!cmpExact(pa[4] ?? null, pb[4] ?? null)) bad = true;   // cad
        if (bad) { diff++; if (samples.length < 5) samples.push({ i, a: pa, b: pb }); }
    }
    return { equal: diff === 0, reason: diff ? `${diff} of ${a.length} points differ` : null, diffPoints: diff, samples };
}

function diffRow(a, b) {
    const diffs = [];
    for (const f of HARD_STR) if (!cmpExact(a[f] ?? null, b[f] ?? null)) diffs.push({ field: f, a: a[f], b: b[f], soft: false });
    for (const f of HARD_INT) if (!cmpExact(a[f] ?? null, b[f] ?? null)) diffs.push({ field: f, a: a[f], b: b[f], soft: false });
    for (const [f, eps] of Object.entries(HARD_FLOAT)) if (!cmpFloat(a[f], b[f], eps)) diffs.push({ field: f, a: a[f], b: b[f], soft: false });
    if (!cmpTime(a.start_time, b.start_time)) diffs.push({ field: 'start_time', a: a.start_time, b: b.start_time, soft: false });
    const geo = cmpGeo(a.geo_points, b.geo_points);
    if (!geo.equal) diffs.push({ field: 'geo_points', a: geo.reason, b: null, soft: false, geo: { diffPoints: geo.diffPoints, samples: geo.samples } });
    for (const f of SOFT) if (!cmpExact(a[f] ?? null, b[f] ?? null)) diffs.push({ field: f, a: a[f], b: b[f], soft: true });
    return diffs;
}

const cap = (arr, n) => arr.length > n ? arr.slice(0, n).concat([`…(+${arr.length - n} more)`]) : arr;

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
    // Trim to guard against a stray newline/space from how the key was supplied —
    // an invalid character in the key produces undici "invalid Authorization header".
    const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
    const SERVICE_KEY  = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!SUPABASE_URL || !SERVICE_KEY) die('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars before running.');

    const argv = process.argv.slice(2);
    let outPath = null, summaryOnly = false; const positional = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') outPath = argv[++i];
        else if (argv[i] === '--summary-only') summaryOnly = true;
        else positional.push(argv[i]);
    }
    if (positional.length !== 2) die('Usage: node scripts/compare-accounts.js <prodEmailOrId> <testEmailOrId> [--out <path>] [--summary-only]');
    const [refA, refB] = positional;

    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const A = await resolveUser(sb, refA);
    const B = await resolveUser(sb, refB);

    const [rowsA, rowsB] = await Promise.all([fetchActivities(sb, A.id), fetchActivities(sb, B.id)]);
    const idxA = indexBySourceId(rowsA), idxB = indexBySourceId(rowsB);

    const onlyA = [], onlyB = [], matched = [];
    for (const [sid, ra] of idxA.map) {
        const rb = idxB.map.get(sid);
        if (!rb) onlyA.push(sid);
        else matched.push({ sid, name: ra.name, diffs: diffRow(ra, rb) });
    }
    for (const sid of idxB.map.keys()) if (!idxA.map.has(sid)) onlyB.push(sid);

    const hardTally = {}, softTally = {};
    let rowsWithHard = 0, rowsWithSoftOnly = 0;
    const detailed = [];
    for (const m of matched) {
        const hard = m.diffs.filter(d => !d.soft), soft = m.diffs.filter(d => d.soft);
        if (hard.length) rowsWithHard++; else if (soft.length) rowsWithSoftOnly++;
        for (const d of hard) hardTally[d.field] = (hardTally[d.field] || 0) + 1;
        for (const d of soft) softTally[d.field] = (softTally[d.field] || 0) + 1;
        if (m.diffs.length) detailed.push({ source_id: m.sid, name: m.name, diffs: m.diffs });
    }

    const hasHardDrift = onlyA.length > 0 || onlyB.length > 0 || rowsWithHard > 0 ||
                         idxA.dupes.length > 0 || idxB.dupes.length > 0;

    const report = {
        generated_at: new Date().toISOString(),
        accounts: { A: { ref: A.label, id: A.id, rows: rowsA.length }, B: { ref: B.label, id: B.id, rows: rowsB.length } },
        summary: {
            matched: matched.length,
            only_in_A: onlyA.length, only_in_B: onlyB.length,
            rows_with_hard_diffs: rowsWithHard, rows_with_soft_diffs_only: rowsWithSoftOnly,
            null_source_id: { A: idxA.nullId.length, B: idxB.nullId.length },
            duplicate_source_id: { A: idxA.dupes.length, B: idxB.dupes.length },
            hard_field_tally: hardTally, soft_field_tally: softTally,
        },
        only_in_A: onlyA, only_in_B: onlyB,
        diffs: detailed,
    };

    // ── Console summary ──
    const line = '─'.repeat(60);
    console.log(line);
    console.log(`TrackLog account comparison`);
    console.log(`  A: ${A.label}  (${A.id})  → ${rowsA.length} activities`);
    console.log(`  B: ${B.label}  (${B.id})  → ${rowsB.length} activities`);
    console.log(line);
    console.log(`Matched on source_id:        ${matched.length}`);
    console.log(`Only in A (orphans):         ${onlyA.length}`);
    console.log(`Only in B (orphans):         ${onlyB.length}`);
    console.log(`Matched w/ HARD diffs:       ${rowsWithHard}`);
    console.log(`Matched w/ SOFT diffs only:  ${rowsWithSoftOnly}`);
    if (idxA.nullId.length || idxB.nullId.length) console.log(`Null source_id (unmatchable): A=${idxA.nullId.length} B=${idxB.nullId.length}`);
    if (idxA.dupes.length || idxB.dupes.length)   console.log(`Duplicate source_id:          A=${idxA.dupes.length} B=${idxB.dupes.length}`);
    console.log(line);
    if (Object.keys(hardTally).length) {
        console.log('HARD field mismatch tally (count of matched rows differing):');
        for (const [f, n] of Object.entries(hardTally).sort((x, y) => y[1] - x[1])) console.log(`  ${f.padEnd(14)} ${n}`);
    } else {
        console.log('HARD field mismatches: none 🎉');
    }
    if (Object.keys(softTally).length) {
        console.log('SOFT field tally (informational):');
        for (const [f, n] of Object.entries(softTally).sort((x, y) => y[1] - x[1])) console.log(`  ${f.padEnd(14)} ${n}`);
    }
    if (onlyA.length) { console.log(line); console.log(`Only in A (first 20):`); cap(onlyA, 20).forEach(s => console.log('  ' + s)); }
    if (onlyB.length) { console.log(line); console.log(`Only in B (first 20):`); cap(onlyB, 20).forEach(s => console.log('  ' + s)); }

    // ── JSON report ──
    console.log(line);
    if (summaryOnly) {
        console.log('(--summary-only: no report file written)');
    } else {
        const ts = report.generated_at.replace(/[:.]/g, '-');
        const file = outPath || `compare-report-${ts}.json`;
        fs.writeFileSync(file, JSON.stringify(report, null, 2));
        console.log(`Full report written to: ${file}`);
    }
    console.log(hasHardDrift ? 'RESULT: drift detected (exit 1)' : 'RESULT: accounts match (exit 0)');

    process.exit(hasHardDrift ? 1 : 0);
}

// Exported for unit testing; run only when invoked directly.
module.exports = { diffRow, cmpGeo, cmpFloat, cmpExact, cmpTime, indexBySourceId, HARD_FLOAT };

if (require.main === module) {
    run().catch(e => die(e.stack || e.message));
}
