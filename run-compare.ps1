# run-compare.ps1 — run the TrackLog account comparison.
#
# Reads the Supabase service_role key from the clipboard. Pasting a 200+ char JWT
# into a masked Read-Host prompt can truncate or inject a stray newline (which makes
# an invalid Authorization header), so we read the clipboard instead. The key never
# prints to screen and is never written to disk or PowerShell history.
#
# Usage:
#   1) Copy your service_role key (Supabase dashboard -> Settings -> API) to clipboard.
#   2) .\run-compare.ps1 you@example.com you@example.com      # self-test
#      .\run-compare.ps1 prod@example.com test@example.com    # prod vs test
#
# Each arg is an account email or a raw user UUID.

param(
    [Parameter(Mandatory = $true)][string]$AccountA,
    [Parameter(Mandatory = $true)][string]$AccountB
)

Write-Host "Copy your Supabase service_role key to the clipboard, then press Enter."
Read-Host "Press Enter when the key is on the clipboard" | Out-Null

$key = Get-Clipboard -Raw
if (-not $key) { Write-Error "Clipboard is empty. Copy the service_role key and run again."; exit 1 }
$key = $key.Trim()
Write-Host ("Key length: {0} chars" -f $key.Length)
if ($key.Length -lt 100) {
    Write-Warning "That looks too short for a service_role JWT (expect ~200+ chars). Re-copy the full key."
}

$env:SUPABASE_URL = "https://nfvxmkknkxysjksyhbek.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = $key

# Run from the repo root (this script's folder) so the report lands here and is
# covered by the compare-report-*.json .gitignore rule.
Push-Location $PSScriptRoot
try {
    node "scripts\compare-accounts.js" $AccountA $AccountB
}
finally {
    Pop-Location
    Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
}
