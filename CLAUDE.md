# TrackLog

GPS activity viewer. Imports activities from local file exports (Strava bulk download, Apple Health, or any GPX source) and automatically via Dropbox sync (HealthFit → Dropbox → TrackLog).

## Deploy Workflow

Commit changes → push to GitHub → Vercel auto-deploys via GitHub integration.
Do **not** use `vercel --prod` directly.

## Architecture

Static HTML + Vercel serverless API functions. No build step. Same pattern as TrailView.

```
tracklog/
├── index.html              — single-page app (auth, Leaflet map, import pipeline, all UI)
├── tracklog-icon.svg       — app icon (blue gradient, GPS map pin + pulse rings)
├── supabase-setup.sql      — run once in Supabase dashboard to create tables
├── supabase.umd.js         — self-hosted Supabase JS library
├── manifest.json           — PWA manifest
├── sw.js                   — service worker (cache: tracklog-v1)
├── api/
│   ├── _lib/
│   │   ├── supabase.js     — serviceClient() and anonClient() singletons
│   │   ├── auth.js         — verifyUser() and verifyApprovedUser() (uses tl_profiles)
│   │   └── gpx.js          — server-side GPX + TCX parser (fast-xml-parser); shared by dropbox.js
│   ├── profile.js          — GET /api/profile; admin: list, approve, invite, delete
│   ├── types.js            — GET /api/types (distinct activity types + colors)
│   ├── list.js             — GET /api/list (scalar metadata, bbox/date filters)
│   ├── latlngs.js          — GET /api/latlngs (50-pt polylines for map)
│   ├── track.js            — GET /api/track?id=<uuid> (full detail + elevation)
│   ├── delete.js           — POST /api/delete?id=<uuid>
│   ├── import.js           — POST /api/import (batch upsert of pre-processed activities)
│   ├── wipe.js             — POST /api/wipe (delete all activities for user)
│   └── dropbox.js          — all Dropbox actions behind ?action= (same pattern as profile.js):
│                              GET ?challenge=X          — webhook verification (echo challenge)
│                              GET ?action=auth          — returns Dropbox OAuth URL
│                              GET ?action=callback      — OAuth redirect handler (no JWT, redirects)
│                              GET ?action=status        — connected status + folder path
│                              POST ?action=sync         — manual sync (list folder, download, import)
│                              POST ?action=disconnect   — remove tokens
│                              POST (no action)          — webhook notification (HMAC-verified)
└── package.json            — dependencies: @supabase/supabase-js, fast-xml-parser
```

**9-function count (3 slots free):** Vercel Hobby plan allows max 12 serverless functions.

## Supabase

Shared project `nfvxmkknkxysjksyhbek` (same as all CharlesLogic apps). Tables use `tl_` prefix.

**One-time setup:** Run `supabase-setup.sql` in the Supabase SQL editor.

Tables:
- `tl_profiles` — one row per user, `approved` boolean, display_name
- `tl_activities` — one row per activity. Key columns:
  - `geo_points JSONB` — 50-pt `[[lat,lon,ele,hr?,cad?]]`: 3 slots when no extension data, 5 slots when HR or cadence is present (null for whichever is absent)
  - `max_speed FLOAT` — from Strava CSV "Max Speed" (m/s)
  - `avg_hr INT`, `max_hr INT` — from Strava CSV scalars; used as fallback when per-point HR is absent from GPX
  - `avg_cad INT` — from Strava CSV "Average Cadence"; fallback when GPX cadence absent
  - `location TEXT` — "City, ST" reverse-geocoded at import time via Nominatim; shown in track list and detail panel
- `tl_invites` — email-based invite list
- `tl_dropbox_tokens` — per-user Dropbox OAuth tokens: `dropbox_account_id`, `access_token`, `refresh_token`, `expires_at`, `folder_path`

**Pre-existing Supabase users** won't have a `tl_profiles` row. Insert manually:
```sql
INSERT INTO tl_profiles (id, display_name, approved)
SELECT id, raw_user_meta_data->>'full_name', false
FROM auth.users WHERE email = 'user@example.com'
ON CONFLICT (id) DO NOTHING;
```

## Environment Variables

Set in Vercel dashboard for the `tracklog` project:

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | `https://nfvxmkknkxysjksyhbek.supabase.co` |
| `SUPABASE_ANON_KEY` | (from Supabase dashboard → Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | (from Supabase dashboard → Settings → API) |
| `APP_URL` | `https://tracks.charleslogic.com` |
| `TL_ADMIN_USER_ID` | Supabase UUID of the admin user |
| `RESEND_API_KEY` | For invite emails |
| `DROPBOX_APP_KEY` | Dropbox app key (from Dropbox App Console) |
| `DROPBOX_APP_SECRET` | Dropbox app secret (from Dropbox App Console) |

## Dropbox Auto-Sync

Replaces the old Strava API integration. Pipeline:
```
Apple Watch (WorkOutDoors) → Apple Health → HealthFit (iOS) → Dropbox /Apps/HealthFitExporter/ → TrackLog
```

HealthFit automatically exports new workouts as GPX files to Dropbox after each workout syncs to Apple Health. TCX files are also supported if a future export source uses that format.

### How it works

- **Per-user tokens**: Each user connects their own Dropbox account via OAuth. Tokens stored in `tl_dropbox_tokens`. Multiple family members each link their own Dropbox.
- **App-level credentials**: `DROPBOX_APP_KEY` and `DROPBOX_APP_SECRET` identify the TrackLog application to Dropbox (not per-user — same for everyone, correct to keep in env vars).
- **Webhook**: Dropbox POSTs to `/api/dropbox` when files change. The handler verifies the HMAC-SHA256 signature against the **raw request body bytes** (not re-serialized JSON — Vercel's body parser is disabled via `module.exports.config = { api: { bodyParser: false } }` so we read raw bytes directly). Looks up which TrackLog user owns the changed Dropbox account and syncs their new GPX files.
- **Manual sync**: "Sync from Dropbox" button in the user menu triggers the same logic on demand.
- **File formats**: Picks up `.gpx`, `.tcx`, `.gpx.gz`, and `.tcx.gz` files. TCX format is preferred when available — it includes `DistanceMeters` from the recording device (pedometer-accurate) rather than requiring GPS summation.
- **Deduplication**: Uses existing `source_id` upsert. HealthFit files named `Route_*.gpx` get `source_id = 'ah_route_...'` from filename alone, so already-imported files are skipped before downloading.
- **Token refresh**: Short-lived Dropbox tokens are refreshed automatically before each API call if within 5 minutes of expiry.
- **Webhook sync is synchronous**: The handler awaits all `syncForUser()` calls before responding 200. Vercel terminates functions after the response is sent, so fire-and-forget doesn't work — work must complete before responding. Dropbox allows 10s; syncing a few new files typically takes 2-3s.
- **Dropbox folder as transit queue**: The `/Apps/HealthFitExporter/` folder is not a permanent archive — it's a delivery queue. GPX files are tiny so it won't grow large, but it can be cleared manually any time without affecting TrackLog data (the DB is the source of truth).
- **Development mode / testers**: The app stays in Development status. Any Dropbox account can authorize (up to 500) — no need to pre-add testers. Family members just click Connect Dropbox and authorize normally.

### Data sources and roles

| Source | Role | Notes |
|--------|------|-------|
| Strava | Master archive | Bulk export is the recovery path; keep HealthFit → Strava sync active |
| HealthFit → Dropbox | Live sync lane | Richer data than Strava (full HR, photos); auto-imports new activities |
| TrackLog DB | Working copy | Derived from either source; safe to wipe and rebuild |

### Wipe + reimport recovery procedure

If you wipe TrackLog and reimport from a Strava bulk export:

1. **Wipe TrackLog** (user menu → manager mode → Wipe all activities)
2. **Clear the Dropbox folder** manually — delete all files from `/Apps/HealthFitExporter/` in Dropbox
3. **Reimport Strava bulk export** via the Import button
4. Going forward, Dropbox picks up only new activities (no duplicates)

**Why step 2 is required:** Strava and HealthFit generate different `source_id` values for the same activity (`strava_12345` vs `ah_route_...`). After a wipe, the DB has no memory of the HealthFit files, so the next Dropbox sync would reimport everything as duplicates. Clearing the folder prevents this.

### Dropbox App Console setup (one-time)

1. Create app at https://www.dropbox.com/developers/apps — Scoped access
2. **Permissions tab**: enable `files.metadata.read` AND `files.content.read`
3. **OAuth 2 → Redirect URIs**: add `https://tracks.charleslogic.com/api/dropbox?action=callback`
4. **Webhooks**: add `https://tracks.charleslogic.com/api/dropbox`
5. **Settings → Testers**: add each family member's Dropbox email (required while app is in Development status — no Dropbox review needed for a private app)

**Development vs Production status:** The app stays in Development mode. Add each user's Dropbox account email as a Tester in the App Console. No production review needed.

### Connect flow (per user)

1. User clicks "Connect Dropbox" in user menu
2. App calls `GET /api/dropbox?action=auth` → server returns OAuth URL with signed `state` containing user ID
3. User authorizes on Dropbox
4. Dropbox redirects to `APP_URL/api/dropbox?action=callback`
5. Server verifies state HMAC, exchanges code for tokens, stores in `tl_dropbox_tokens`, redirects to app
6. App shows toast "Dropbox connected!" and status line updates

## Import Flow (client-side, manual)

1. User clicks "Import activities" in the user menu
2. `showDirectoryPicker()` opens a folder picker (Chrome/Edge only)
3. App walks the folder tree recursively, collecting `.gpx`, `.tcx`, and `.gz` files
4. If `activities.csv` is found at the root (Strava export), it's parsed for metadata (name, type, activity ID, max speed, avg/max HR, avg cadence)
5. Each file is parsed with `DOMParser`; `.gz` files are decompressed with `DecompressionStream('gzip')` (built-in browser API, no library needed)
6. **TCX files** (`parseTcx`): distance comes from `<Lap><DistanceMeters>` (device pedometer, accurate). HR, cadence, max speed, total time from Lap-level fields. Sport attribute maps to activity type directly.
7. **GPX files** (`parseGpx`): track points decimated to 50 pts; HR (`gpxtpx:hr`) and cadence (`gpxtpx:cad`) from extensions. Distance computed from GPS with speed-based noise filter — see GPS Distance Accuracy below.
8. Metadata enrichment:
   - **Strava export**: CSV provides name, type (mapped via TYPE_MAP), activity ID, max_speed, avg_hr, max_hr, avg_cad
   - **Apple Health**: filename starts with `Route_` → `source_id = "ah_Route_..."`; type inferred from speed
   - **Generic GPX/TCX**: type inferred from speed/elevation (GPX) or Sport attribute (TCX); `source_id` from start time + coordinates
9. Start lat/lon is reverse-geocoded via Nominatim (free, no key) to produce a "City, ST" location string. Results cached in-memory by ~11km grid cell so repeated imports of the same area cost only 1 API call. Nominatim rate limit: 1 req/sec.
10. Activities batch-POSTed to `/api/import` (20 per batch)
11. On completion, types and map reload

**No wipe on import** — every import is a safe upsert. Re-importing updates existing records (fixes names/types) and adds new ones. Duplicate detection uses `source_id` per user.

## GPX/TCX Parsing (server-side)

`api/_lib/gpx.js` exports two parsers used by `api/dropbox.js`:
- `parseGpxBuffer(buf, filename)` — GPX via fast-xml-parser; same logic as client-side `parseGpx()`
- `parseTcxBuffer(buf, filename)` — TCX via fast-xml-parser; reads `DistanceMeters` from Lap elements

The same `TYPE_MAP`, `inferType`, `decimate`, `haversineM`, and `makeSourceId` functions are shared. If you change the client-side logic, mirror the change in `_lib/gpx.js` and vice versa.

## GPS Distance Accuracy

GPX distance is computed from raw GPS coordinates using a **speed-based noise filter**: segments implying speed > 10 m/s (~22 mph) between consecutive kept points are rejected as GPS jumps. Falls back to a 3 m minimum-distance threshold for files without timestamps.

**Known limitation:** Apple Watch records GPS at ~1 Hz. At walking pace (~1.4 m/s), real movement per sample is smaller than typical urban GPS noise (5–15 m in Las Vegas-style dense environments). The speed filter removes the worst GPS spikes but cannot eliminate all noise — GPX-computed distance will be higher than the Watch's pedometer-based distance shown in HealthFit/Apple Health.

**TCX avoids this entirely** by reading `DistanceMeters` directly from the device. For Apple Watch workouts, export TCX from Garmin Connect or similar if available; HealthFit (as of 2026) only exports GPX, FIT, CSV, or Markdown.

## Type Normalization

All activity type strings are lowercased and stripped of whitespace/hyphens before lookup in `TYPE_MAP` (defined in both `index.html` and `api/_lib/gpx.js`). Unknown types pass through as-is and get a palette color. To normalize a new variant (e.g. "cycling" → "ride"), add it to both TYPE_MAPs and re-import.

## Wipe

"Wipe all activities" button in manager mode (user menu) calls `POST /api/wipe`. Requires confirmation.

## Map Interaction

**Locate Me (◎ button):** places a blue `circleMarker` at the GPS position and pans to it. The marker lives in a dedicated `locationPane` (z-index 650) created at map init. This is required because the heatmap canvas is a separate DOM element that sits above the SVG `overlayPane` (z-index 400) where normal circleMarkers live — `bringToFront()` can't cross that boundary. z-index 650 puts the dot above both the heatmap (400) and the Leaflet markerPane (600).

**Track list:** each item shows name, type · distance · duration, and location. The date column shows the date on one line and the 12-hour time (e.g. `2:15 PM`) below it, right-aligned.

**Track selection:** clicking a track highlights it (white, weight 5, opacity 1) and dims all other polylines to opacity 0.15, weight 2. The heatmap also dims to 0.25. Closing the detail panel restores everything. Same pattern as TrailView.

**`getMapFitOptions(pad, maxZoom)`:** used by all fitBounds calls. On desktop, the map CSS sets `right: var(--panel-w)` so the map div is already sized to exclude the panel — no extra right-padding compensation needed. On mobile the panel slides up from the bottom and overlaps the map, so bottom padding = `50vh + pad` is added. Do NOT add panel-width compensation for desktop; it caused double-shrinking and over-zoomed-out fits.

## Manager Mode

Toggle in browser console: `localStorage.setItem('tl-manager', '1')` then reload.
Shows: wipe button, max tracks input, delete button on track detail, Disconnect Dropbox button.

## Version Display

Nav shows short git SHA from `VERCEL_GIT_COMMIT_SHA` (set by Vercel automatically), emitted as `X-App-Version` response header by `api/types.js` and read from the response in `index.html`. Falls back to cold-start timestamp in local dev. Same pattern as TrailView and Annoyed.

## Service Worker

Cache name `tracklog-v1`. **Do not bump the cache name to deploy new HTML** — the SW uses a **network-first strategy for HTML** (always fetches fresh, falls back to cache when offline). Static assets (Leaflet, supabase.umd.js) are cache-first. API requests (`/api`) are network-only with an offline JSON fallback. Only bump the cache name if the precache list itself changes.

## Auth

Identical to TrailView: OTP + Google OAuth, invite gate, auto-approve on invite. See TrailView CLAUDE.md for full auth documentation. Supabase dashboard settings (session token revocation OFF, Google provider enabled, Resend SMTP) are shared across all apps on the project.

## Differences from TrailView

| Feature | TrailView | TrackLog |
|---------|-----------|----------|
| Data source | Strava API (OAuth per user) | Local GPX import + Dropbox auto-sync |
| Table prefix | `tv_` | `tl_` |
| Token storage | `tv_strava_tokens` (per user) | `tl_dropbox_tokens` (per user) |
| Onboarding wizard | 3-step Strava setup | None (connect Dropbox from user menu) |
| Sync button | Nav bar | User menu ("Sync from Dropbox") |
| Activity ID field | `strava_id` | `source_id` |
| Accent color | Violet `#7c3aed` | Blue `#2563eb` |
| Theme storage key | `tv-theme` | `tl-theme` |
