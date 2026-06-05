# TrackLog — Dropbox Auto-Sync Workflow Spec

## Overview

This document describes a new automated workflow to import cycling activities into TrackLog without manual file handling. Read the existing TrackLog codebase first to understand current architecture, data storage, and GPX import logic before implementing anything described here.

---

## Background

The previous workflow used the Strava API to pull activities into TrackLog. Strava removed API access for non-subscribers, so that integration is no longer viable.

The replacement workflow uses Apple Health as the activity data source, HealthFit as the export bridge, and Dropbox as the delivery mechanism.

---

## Activity Data Flow

```
Apple Watch (WorkOutDoors)
        ↓
  Apple Health
        ↓
  HealthFit (iOS)
        ↓
  Dropbox /Apps/HealthFitExporter/
        ↓
  TrackLog (via webhook or manual sync)
```

**WorkOutDoors** on Apple Watch records the ride and syncs to Apple Health automatically.

**HealthFit** is an iOS app already configured to monitor Apple Health and automatically export new activities as GPX files to a Dropbox folder (`/Apps/HealthFitExporter/`). This happens without user interaction after a workout syncs to Health.

**Dropbox** acts as the delivery queue. New GPX files appear in the folder as HealthFit deposits them.

**TrackLog** needs to detect and import those new GPX files.

---

## Fallback Sources

HealthFit reads from Apple Health regardless of how the activity was recorded. This means the same pipeline handles all scenarios automatically:

- Ride recorded on Apple Watch via WorkOutDoors (primary)
- Ride recorded via iPhone native Fitness app (watch battery dead)
- Any other workout source that writes to Apple Health

No special fallback logic is needed — HealthFit and Dropbox handle it transparently.

---

## What Needs to Be Built in TrackLog

### 1. Dropbox Webhook Endpoint

Dropbox can notify TrackLog automatically when new files are deposited in the HealthFit folder. This requires two endpoint behaviors:

**Verification (GET):** When the webhook is first registered in the Dropbox developer console, Dropbox sends a GET request with a `challenge` query parameter. The endpoint must echo the challenge value back immediately. This is a one-time verification step.

**Notification (POST):** After verification, Dropbox sends a POST request whenever files change in the connected account. The notification does not include the file itself — it is just a signal that something changed. The endpoint must then call the Dropbox API to list the HealthFit folder, identify any new GPX files, download them, and pass them to the existing GPX import logic.

### 2. Duplicate Detection

Dropbox may send multiple notifications for the same file, and manual syncs may overlap with webhook syncs. The import logic must track which files have already been imported (by filename or a derived unique identifier) and skip anything already processed.

### 3. Manual Sync Button (Fallback)

In addition to the automatic webhook, provide a manual sync button in the TrackLog UI — similar to the previous "Sync from Strava" button. This button triggers the same folder-check-and-import logic on demand, giving the user a way to force a sync if the webhook misfired or HealthFit was delayed.

---

## Configuration

The following values should be stored as environment variables, not hardcoded - but need to consaider multi user support which would be db storage:

- Dropbox API access token (for calling the Dropbox API to list and download files)
- Dropbox folder path to monitor (`/Apps/HealthFitExporter/`)
- Optional: a shared secret for validating that webhook POST requests genuinely originate from Dropbox

---

## GPX Files

HealthFit exports standard GPX format. The existing TrackLog GPX import logic should handle these files as-is. Verify that the existing importer handles the `<gpxtpx:hr>` heart rate extension namespace if heart rate display is desired — HealthFit includes heart rate in its GPX exports if the watch recorded it.

---

## Implementation Order

1. Read and understand the existing TrackLog codebase — especially current GPX import logic, data storage, and any existing API endpoints
2. Build and deploy the webhook verification endpoint (GET) so it can be registered in Dropbox
3. Register the webhook URL in the Dropbox developer console
4. Build the webhook notification handler (POST) — folder listing, new file detection, download, import
5. Add duplicate detection
6. Add the manual sync button to the UI, wired to the same import logic
7. Test end-to-end with a real activity from HealthFit

---

## Notes


- Dropbox webhook notifications signal that *something* changed but do not identify *what* changed. The handler must always list the folder and diff against known imports.
- HealthFit deposits files automatically when Apple Health receives a new workout. There is typically a short delay between workout completion and file appearance in Dropbox.
- The Dropbox free plan supports API access at the call volumes this app requires.
