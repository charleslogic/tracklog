# TrackLog

GPS activity viewer. Imports activities from local file exports (Strava bulk download, Apple Health, or any GPX source). No Strava API — all data comes from file imports picked by the user.

## Deploy Workflow

Commit changes → push to GitHub → Vercel auto-deploys via GitHub integration.
Do **not** use `vercel --prod` directly.

## Architecture

Static HTML + Vercel serverless API functions. No build step. Same pattern as TrailView.

```
tracklog/
├── index.html              — single-page app (auth, Leaflet map, import pipeline, all UI)
├── tracklog-icon.png       — app icon (needs to be created)
├── supabase-setup.sql      — run once in Supabase dashboard to create tables
├── supabase.umd.js         — self-hosted Supabase JS library
├── manifest.json           — PWA manifest
├── sw.js                   — service worker (cache: tracklog-v1)
├── api/
│   ├── _lib/
│   │   ├── supabase.js     — serviceClient() and anonClient() singletons
│   │   └── auth.js         — verifyUser() and verifyApprovedUser() (uses tl_profiles)
│   ├── profile.js          — GET /api/profile; admin: list, approve, invite, delete
│   ├── types.js            — GET /api/types (distinct activity types + colors)
│   ├── list.js             — GET /api/list (scalar metadata, bbox/date filters)
│   ├── latlngs.js          — GET /api/latlngs (50-pt polylines for map)
│   ├── track.js            — GET /api/track?id=<uuid> (full detail + elevation)
│   ├── delete.js           — POST /api/delete?id=<uuid>
│   ├── import.js           — POST /api/import (batch upsert of pre-processed activities)
│   └── wipe.js             — POST /api/wipe (delete all activities for user)
└── package.json
```

**8-function count (4 slots free):** Vercel Hobby plan allows max 12 serverless functions.

## Supabase

Shared project `nfvxmkknkxysjksyhbek` (same as all CharlesLogic apps). Tables use `tl_` prefix.

**One-time setup:** Run `supabase-setup.sql` in the Supabase SQL editor.

Tables:
- `tl_profiles` — one row per user, `approved` boolean, display_name
- `tl_activities` — one row per activity, `geo_points JSONB` stores 50-pt `[[lat,lon,ele|null]]`
- `tl_invites` — email-based invite list

**No `tl_strava_tokens` table** — TrackLog does not use the Strava API.

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

## Import Flow (client-side)

1. User clicks "Import activities" in the user menu
2. `showDirectoryPicker()` opens a folder picker (Chrome/Edge only)
3. App walks the folder tree recursively, collecting `.gpx` and `.gz` files
4. If `activities.csv` is found at the root (Strava export), it's parsed for metadata (name, type, activity ID)
5. Each GPX file is parsed with `DOMParser`; `.gz` files are decompressed with `DecompressionStream('gzip')` (built-in browser API, no library needed)
6. Track points are decimated to 50 points client-side
7. Metadata enrichment:
   - **Strava export**: CSV provides name, type (mapped via TYPE_MAP), and numeric activity ID → `source_id = "strava_12345678"`
   - **Apple Health**: GPX filename starts with `Route_` → `source_id = "ah_Route_..."`; type inferred from speed
   - **Generic GPX**: type inferred from speed/elevation, `source_id` from start time + coordinates
8. Activities batch-POSTed to `/api/import` (20 per batch)
9. On completion, types and map reload

**No wipe on import** — every import is a safe upsert. Re-importing updates existing records (fixes names/types) and adds new ones. Duplicate detection uses `source_id` per user.

## Type Normalization

All activity type strings are lowercased and stripped of whitespace/hyphens before lookup in `TYPE_MAP` (defined in `index.html`). Unknown types pass through as-is and get a palette color. To normalize a new variant (e.g. "cycling" → "ride"), just add it to `TYPE_MAP` and re-import — the upsert will update existing records.

## Wipe

"Wipe all activities" button in manager mode (user menu) calls `POST /api/wipe`. Requires confirmation. Used sparingly — day-to-day workflow is always add/update via import.

## Manager Mode

Toggle in browser console: `localStorage.setItem('tl-manager', '1')` then reload.
Shows: wipe button, max tracks input, delete button on track detail.

## Version Display

Nav shows short git SHA from `VERCEL_GIT_COMMIT_SHA` (set by Vercel), formatted in `api/types.js`. Falls back to cold-start time in local dev.

## Auth

Identical to TrailView: OTP + Google OAuth, invite gate, auto-approve on invite. See TrailView CLAUDE.md for full auth documentation. Supabase dashboard settings (session token revocation OFF, Google provider enabled, Resend SMTP) are shared across all apps on the project.

## Differences from TrailView

| Feature | TrailView | TrackLog |
|---------|-----------|----------|
| Data source | Strava API (OAuth) | Local file import (GPX) |
| Table prefix | `tv_` | `tl_` |
| Strava tokens table | Yes | No |
| Onboarding wizard | 3-step Strava setup | None (just import) |
| Sync button | Nav bar | None |
| Activity ID field | `strava_id` | `source_id` |
| Accent color | Green `#2563eb... #2d7d3a` | Blue `#2563eb` |
| Theme storage key | `tv-theme` | `tl-theme` |
