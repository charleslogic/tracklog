# scripts/

Local maintenance scripts. These run on your machine with the Supabase **service
role** key — they are **not** Vercel functions and don't count against the 12-function
Hobby limit.

## compare-accounts.js

Diffs two TrackLog accounts' `tl_activities` to detect drift between your long-lived
**prod** account (which accumulates state through continuous Dropbox-sync upserts) and
a freshly wiped+reimported **test** control account seeded from the *same* source files.

Because both accounts ingest the identical Strava bulk export + the same copied
HealthFit files through the identical import code, `source_id` is produced the same way
in both — so it's a clean 1:1 join key. **Any HARD field difference on a matched
`source_id` is a real drift signal**: it means prod's row diverged from a clean rebuild
with the current parser code.

### Setup (one time per shell)

The script needs the same two values that are set in the Vercel dashboard. Get them
from Supabase → Settings → API. **Never commit these.**

PowerShell:
```powershell
$env:SUPABASE_URL = "https://nfvxmkknkxysjksyhbek.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service role key>"
```

Bash:
```bash
export SUPABASE_URL="https://nfvxmkknkxysjksyhbek.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<service role key>"
```

### Usage

```
node scripts/compare-accounts.js <prodEmailOrId> <testEmailOrId> [--out <path>] [--summary-only]
```

- Each account arg is an **email** (resolved to a user id) or a raw **user UUID**.
- Writes a full `compare-report-<timestamp>.json` (override with `--out`).
- `--summary-only` prints just the counts and skips writing the JSON — handy for
  quick re-check loops where you don't need the full diff detail.
- Exit code `0` = accounts match (no HARD diffs, no orphans); `1` = drift detected;
  `2` = usage/config error.

Via the PowerShell wrapper, add `-SummaryOnly`:
```powershell
.\run-compare.ps1 prod@example.com test@example.com -SummaryOnly
```

### What it compares

- **HARD** (a difference = real drift): `name, type, distance, total_time,
  moving_time, elev_gain, elev_loss, avg_speed, max_speed, avg_hr, max_hr, avg_cad,
  start_time, bbox_*`, and **`geo_points`** point-by-point (the point-count and
  3-vs-5-slot checks catch the uniform-shape parser fix directly).
- **SOFT** (reported but not failing): `source` (import-lane label) and `location`
  (reverse-geocoded at import time — Nominatim can answer differently on a later day).
- **Ignored**: `id`, `created_at` (always differ per row).

### Interpreting results

- After the test account is freshly wiped + reimported from identical sources with
  current code, matched rows should show **0 HARD diffs**. SOFT diffs are normal.
- **Only-in-A (prod) orphans** are the other signal — rows that exist only in prod's
  DB and no longer round-trip from a source file (stale / drifted rows).
- A HARD diff after a clean test rebuild means **prod is carrying older-parser data**
  and would benefit from a re-import/upsert (or an occasional full wipe+reimport).

### The test loop (the point of all this)

1. **Self-test first** — run with the same account twice to prove the tool is sound:
   ```
   node scripts/compare-accounts.js you@example.com you@example.com
   ```
   Expect 0 orphans / 0 HARD / 0 SOFT.
2. **Baseline** — wipe the test account (user menu → manager mode → Wipe all
   activities), reimport the identical Strava export + copied HealthFit files, then run
   `compare-accounts.js <prod> <test>`. Investigate any HARD diffs / orphans.
3. **Over time** — keep a dated report after each milestone (initial load → after an
   upsert-only re-sync → after a full wipe+reimport) and watch the diff shrink or grow.

Generated `compare-report-*.json` files are git-ignored.
