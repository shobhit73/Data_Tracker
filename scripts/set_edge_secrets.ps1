# Wrapper around set_edge_secrets.py, for the two keys it has to ask for.
#
# WHY THIS EXISTS
#   Python's getpass shows nothing at all while you type -- no asterisks, no
#   cursor movement -- so a correct paste is indistinguishable from a dead
#   prompt. Read-Host -AsSecureString masks with asterisks instead, which is
#   the feedback that was missing.
#
# Nothing typed here reaches PowerShell history: Read-Host input is never
# recorded, and the values are handed to Python through the process
# environment, which dies with the process. The env vars are cleared in a
# finally block regardless.
#
# Run:  powershell -ExecutionPolicy Bypass -File scripts\set_edge_secrets.ps1

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Read-Secret($label) {
    $secure = Read-Host -Prompt $label -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try   { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

Write-Host "Two keys are not cached on this machine:" -ForegroundColor Cyan
Write-Host "  DASH_SERVICE_KEY  Supabase > nqiyiherkzlhorsnyeni > Settings > API Keys > sb_secret_..."
Write-Host "  CRM_ANON_KEY      the CRM page > F12 > Console > CONFIG.SUPABASE_ANON_KEY"
Write-Host ""

try {
    $env:DASH_SERVICE_KEY = Read-Secret "DASH_SERVICE_KEY"
    $env:CRM_ANON_KEY     = Read-Secret "CRM_ANON_KEY"

    if (-not $env:DASH_SERVICE_KEY -or -not $env:CRM_ANON_KEY) {
        throw "both keys are required"
    }
    if (-not $env:DASH_SERVICE_KEY.StartsWith("sb_secret_")) {
        # The publishable key cannot write, and the failure it causes later is
        # a 401 from PostgREST that looks nothing like "wrong key pasted".
        Write-Host "WARNING: DASH_SERVICE_KEY does not start with sb_secret_ - that is probably the publishable key, which cannot write." -ForegroundColor Yellow
    }

    python (Join-Path $here "set_edge_secrets.py") @args
}
finally {
    Remove-Item Env:\DASH_SERVICE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\CRM_ANON_KEY     -ErrorAction SilentlyContinue
}
