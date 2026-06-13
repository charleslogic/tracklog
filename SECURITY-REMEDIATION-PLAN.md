# TrackLog Security Remediation Plan — 2026-06-13

This is a **plan only**. It does not modify any running app source. The migration
SQL is provided as a standalone file (`supabase-migration-2026-06-security.sql`)
to run once in the Supabase SQL editor; the one application-code change
(`api/profile.js`) is shown below as a proposed diff for you to apply when ready.

Findings reference the full audit (severity, exploit path, file:line) delivered
earlier in this session.

---

## What gets changed, and where

| # | Finding | Severity | Change | Touches running app source? |
|---|---------|----------|--------|------------------------------|
| 1 | `tl_dropbox_tokens` SELECT policy leaks OAuth refresh_token to client | MEDIUM | Replace policy with service-role-only | No — DB only (migration) |
| 2 | `tl_storage_per_user()` callable by any client → user enumeration | MEDIUM | Revoke EXECUTE from anon/authenticated | No — DB only (migration) |
| 3 | `check-email` scans `listUsers({ perPage: 1000 })` per request | LOW–MED | New `tl_check_email` RPC + 1-line endpoint swap | Yes — `api/profile.js` (proposed diff below) |

Findings 4 (constant-time HMAC compare) and 5 (`geo_points` clamp) are hardening,
not included here; they're code-only and can follow separately.

---

## Step 1 + 2 + 3a — Migration SQL (new file, run-once)

Run in the Supabase SQL editor. Idempotent, safe to re-run. This is **not** part
of the deployed app — it's operational DB setup.

```sql
-- TrackLog security migration — 2026-06-13

-- Step 1 — tl_dropbox_tokens: service-role only.
-- The "select own" policy let any logged-in user read their own row (incl. the
-- long-lived refresh_token) via the shipped anon key. The app reads this table
-- only through the service-role API, so remove client SELECT entirely.
DROP POLICY IF EXISTS "tl_dropbox_tokens: select own"   ON tl_dropbox_tokens;
DROP POLICY IF EXISTS "tl_dropbox_tokens: service only" ON tl_dropbox_tokens;
CREATE POLICY "tl_dropbox_tokens: service only"
    ON tl_dropbox_tokens FOR ALL USING (false);

-- Step 2 — tl_storage_per_user(): not client-callable.
-- SECURITY DEFINER + cross-user aggregate; only the admin-gated /api/profile?action=list
-- endpoint calls it via the service role.
REVOKE ALL ON FUNCTION tl_storage_per_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION tl_storage_per_user() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION tl_storage_per_user() TO service_role;

-- Step 3a — tl_check_email(): targeted pre-login lookup.
-- Replaces the listUsers(1000) scan with one indexed existence check. SECURITY
-- DEFINER (reads auth.users + RLS-locked tl_invites), granted to service_role
-- ONLY so it stays server-side (not directly client-callable).
CREATE OR REPLACE FUNCTION tl_check_email(p_email text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    norm text := lower(trim(p_email));
BEGIN
    IF norm = '' THEN
        RETURN 'unknown';
    END IF;
    IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = norm) THEN
        RETURN 'existing';
    END IF;
    IF EXISTS (SELECT 1 FROM tl_invites WHERE lower(email) = norm AND used_by IS NULL) THEN
        RETURN 'invited';
    END IF;
    RETURN 'unknown';
END;
$$;

REVOKE ALL ON FUNCTION tl_check_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION tl_check_email(text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION tl_check_email(text) TO service_role;
```

> Also fold the three blocks into `supabase-setup.sql` (the canonical setup) so a
> fresh install doesn't reintroduce the issues — but that's an edit to apply only
> when you choose, not done here.

---

## Step 3b — `api/profile.js` (proposed diff, NOT applied)

Swap the `check-email` branch to call the new RPC. Apply only after the migration
has run (the endpoint depends on `tl_check_email` existing).

```diff
     // GET /api/profile?action=check-email — unauthenticated pre-login check
     if (req.method === 'GET' && req.query.action === 'check-email') {
         const email = (req.query.email || '').toLowerCase().trim();
         if (!email) return res.status(400).json({ ok: false, error: 'email required' });

-        const [{ data: authData }, { data: invite }] = await Promise.all([
-            serviceClient().auth.admin.listUsers({ perPage: 1000 }),
-            serviceClient().from('tl_invites').select('id').eq('email', email).is('used_by', null).maybeSingle(),
-        ]);
-
-        const existing = (authData?.users || []).some(u => u.email?.toLowerCase() === email);
-        if (existing) return res.json({ ok: true, status: 'existing' });
-        if (invite) return res.json({ ok: true, status: 'invited' });
-        return res.json({ ok: true, status: 'unknown' });
+        const { data: status, error } = await serviceClient().rpc('tl_check_email', { p_email: email });
+        if (error) { console.error('[profile] check-email rpc error:', error); return res.status(500).json({ ok: false, error: 'db_error' }); }
+        return res.json({ ok: true, status: status || 'unknown' });
     }
```

Response contract is unchanged (`existing` / `invited` / `unknown`), so no client
change needed.

---

## Deploy order

1. Run the migration in Supabase (steps 1, 2, 3a). Steps 1 and 2 take effect
   immediately and depend on no code.
2. Apply the `profile.js` diff (3b) and deploy via the normal push-to-GitHub flow.
   Must come **after** 3a, since the endpoint now calls `tl_check_email`.
3. Optional: fold the SQL into `supabase-setup.sql` for fresh installs.

## Post-deploy note (not automated)

The migration closes the leak but does not rotate Dropbox tokens that may already
have been exposed to a client before step 1. To be thorough, after deploy:
disconnect/reconnect Dropbox (or clear `tl_dropbox_tokens`) so any
previously-readable token is invalidated.

## Follow-ups not in this plan

- Finding 4 — constant-time HMAC compare in `api/dropbox.js` (webhook + `verifyState`).
- Finding 5 — clamp/validate `geo_points` size in `api/import.js` (and the Dropbox sync path).
- Edge-level rate limiting on the unauthenticated `check-email` endpoint.
```
