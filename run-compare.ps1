# run-compare.ps1 — run the TrackLog account comparison, prompting for the service
# role key at runtime so it never lands in PowerShell history or on disk.
#
# Usage:
#   .\run-compare.ps1 you@example.com you@example.com      # self-test
#   .\run-compare.ps1 prod@example.com test@example.com    # prod vs test
#
# Each arg is an account email or a raw user UUID.

param(
    [Parameter(Mandatory = $true)][string]$AccountA,
    [Parameter(Mandatory = $true)][string]$AccountB
)

$env:SUPABASE_URL = "https://nfvxmkknkxysjksyhbek.supabase.co"
$sec = Read-Host "Paste service role key" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $sec).Password

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
