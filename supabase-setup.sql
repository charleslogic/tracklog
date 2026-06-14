-- TrackLog — Supabase setup
-- Run once in the Supabase SQL editor at:
-- https://supabase.com/dashboard/project/nfvxmkknkxysjksyhbek/sql
--
-- All tables use tl_ prefix to coexist with other apps in the shared project.

-- ── Activities ─────────────────────────────────────────────────────────────────
-- Source-agnostic: works with Strava export GPX, Apple Health GPX, or any GPX.
-- geo_points holds 50-pt decimated [[lat,lon,ele|null]] — same as TrailView.
-- source_id is used for dedup: re-importing same file updates rather than inserts.

CREATE TABLE IF NOT EXISTS tl_activities (
    id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID          NOT NULL REFERENCES auth.users ON DELETE CASCADE,
    source       TEXT          NOT NULL DEFAULT 'gpx',   -- 'strava', 'apple_health', 'gpx'
    source_id    TEXT,                                    -- activity ID, filename, or content hash
    name         TEXT,
    type         TEXT          NOT NULL DEFAULT 'activity',
    distance     FLOAT,
    total_time   INT,
    moving_time  INT,
    elev_gain    FLOAT,
    elev_loss    FLOAT,
    avg_speed    FLOAT,
    max_speed    FLOAT,
    avg_hr       INT,           -- avg heart rate (bpm); from per-point GPX data or CSV scalar
    max_hr       INT,           -- max heart rate (bpm); from per-point GPX data or CSV scalar
    avg_cad      INT,           -- avg cadence (rpm/spm); from per-point GPX data or CSV scalar
    location     TEXT,          -- "City, ST" from reverse geocoding at import time
    start_time   TIMESTAMPTZ,
    bbox_s       FLOAT,
    bbox_w       FLOAT,
    bbox_n       FLOAT,
    bbox_e       FLOAT,
    geo_points   JSONB,         -- 50-pt [[lat,lon,ele,hr?,cad?],...] — hr/cad slots only when present
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: add columns if upgrading an existing installation
ALTER TABLE tl_activities ADD COLUMN IF NOT EXISTS avg_hr   INT;
ALTER TABLE tl_activities ADD COLUMN IF NOT EXISTS max_hr   INT;
ALTER TABLE tl_activities ADD COLUMN IF NOT EXISTS avg_cad  INT;
ALTER TABLE tl_activities ADD COLUMN IF NOT EXISTS location TEXT;

CREATE INDEX IF NOT EXISTS tl_act_user_time_idx ON tl_activities(user_id, start_time DESC);
CREATE INDEX IF NOT EXISTS tl_act_user_type_idx ON tl_activities(user_id, type);

-- Unique index for dedup. NULL source_ids are inherently distinct in PostgreSQL
-- (NULL != NULL for uniqueness), so no partial index needed. A plain index also
-- lets Supabase's upsert find the constraint via onConflict: 'user_id,source_id'.
CREATE UNIQUE INDEX IF NOT EXISTS tl_act_source_uniq ON tl_activities(user_id, source_id);

-- ── Profiles (approval gate) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tl_profiles (
    id           UUID    PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
    display_name TEXT,
    approved     BOOLEAN DEFAULT FALSE,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION tl_handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.tl_profiles (id, display_name)
    VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name')
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tl_on_auth_user_created ON auth.users;
CREATE TRIGGER tl_on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION tl_handle_new_user();

-- ── Invites ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tl_invites (
    id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    email        TEXT    NOT NULL,
    created_by   UUID    NOT NULL REFERENCES auth.users ON DELETE CASCADE,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    used_by      UUID    REFERENCES auth.users ON DELETE SET NULL,
    used_at      TIMESTAMPTZ
);

-- ── Helper RPC ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tl_distinct_activity_types(p_user_id uuid)
RETURNS TABLE(type text)
LANGUAGE sql
AS $$
    SELECT DISTINCT type
    FROM tl_activities
    WHERE user_id = p_user_id AND type IS NOT NULL
    ORDER BY type;
$$;

-- Returns per-user activity count and estimated total row storage (bytes)
-- for tl_activities, used by the admin panel's "storage per user" view.
CREATE OR REPLACE FUNCTION tl_storage_per_user()
RETURNS TABLE(user_id uuid, activity_count bigint, storage_bytes bigint)
LANGUAGE sql
SECURITY DEFINER
AS $$
    SELECT
        user_id,
        COUNT(*) AS activity_count,
        SUM(pg_column_size(tl_activities.*))::bigint AS storage_bytes
    FROM tl_activities
    GROUP BY user_id;
$$;

-- SECURITY DEFINER + cross-user aggregate; only the admin-gated
-- /api/profile?action=list endpoint calls it, via the service role.
REVOKE ALL ON FUNCTION tl_storage_per_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION tl_storage_per_user() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION tl_storage_per_user() TO service_role;

-- ── Row Level Security ─────────────────────────────────────────────────────────
ALTER TABLE tl_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE tl_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tl_invites    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tl_activities: select own" ON tl_activities;
DROP POLICY IF EXISTS "tl_profiles: select own"   ON tl_profiles;
DROP POLICY IF EXISTS "tl_invites: service only"  ON tl_invites;

CREATE POLICY "tl_activities: select own"
    ON tl_activities FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "tl_profiles: select own"
    ON tl_profiles FOR SELECT USING (auth.uid() = id);

-- tl_invites managed exclusively by service role (Vercel functions).
CREATE POLICY "tl_invites: service only"
    ON tl_invites FOR ALL USING (false);

-- ── Dropbox tokens (per-user OAuth tokens) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS tl_dropbox_tokens (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES auth.users ON DELETE CASCADE,
    dropbox_account_id  TEXT,                           -- dbid:... for webhook routing
    access_token        TEXT,
    refresh_token       TEXT,
    expires_at          TIMESTAMPTZ,
    folder_path         TEXT        NOT NULL DEFAULT '/Apps/HealthFitExporter',
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
);
ALTER TABLE tl_dropbox_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tl_dropbox_tokens: select own"   ON tl_dropbox_tokens;
DROP POLICY IF EXISTS "tl_dropbox_tokens: service only" ON tl_dropbox_tokens;
-- The app reads this table only through the service-role API (api/dropbox.js),
-- so no client policy is needed — block all client access, including own rows
-- (this table holds long-lived OAuth refresh tokens).
CREATE POLICY "tl_dropbox_tokens: service only"
    ON tl_dropbox_tokens FOR ALL USING (false);

-- ── Pre-existing user (manual insert) ─────────────────────────────────────────
-- Pre-existing Supabase users won't get a tl_profiles row from the trigger
-- (trigger only fires on new signups). Insert manually:
--
-- INSERT INTO tl_profiles (id, display_name, approved)
-- SELECT id, raw_user_meta_data->>'full_name', false
-- FROM auth.users WHERE email = 'user@example.com'
-- ON CONFLICT (id) DO NOTHING;
