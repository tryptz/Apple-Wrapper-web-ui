<#
  Re-authenticate the Apple Music wrapper after a password change.

  Why this exists: entrypoint.sh ignores USERNAME/PASSWORD whenever a session
  already exists in rootfs/data, so simply "logging in again" silently reuses
  the old (now revoked) token. This signs OUT first - destroying the stale
  session - and only then signs in, which is what actually forces a fresh
  token to be minted.

  The password is read with no echo, held only in memory for the single HTTP
  call, and zeroed immediately after. It is never written to disk, never
  printed, and never placed on a command line (so it cannot leak into shell
  history or the process list).

  NOTE: this file is deliberately pure ASCII. PowerShell 5.1 reads a BOM-less
  UTF-8 script as ANSI, and multi-byte characters (em dashes, box drawing)
  decode into bytes that include quote characters, which breaks parsing.

  Usage:
    .\resignin.ps1                                  # agent on this machine
    .\resignin.ps1 -Agent http://<your-agent-host>:8080 # agent over Tailscale
#>
[CmdletBinding()]
param(
  [string] $Agent = 'http://127.0.0.1:8080',
  [string] $AppleId
)

$ErrorActionPreference = 'Stop'
$Agent = $Agent.TrimEnd('/')

function Step($n, $msg) { Write-Host ("[{0}] {1}" -f $n, $msg) -ForegroundColor Cyan }
function Ok($msg)       { Write-Host ("    " + $msg) -ForegroundColor Green }
function Bad($msg)      { Write-Host ("    " + $msg) -ForegroundColor Red }

Write-Host ""
Write-Host "Apple Music wrapper - re-authenticate" -ForegroundColor White
Write-Host "agent: $Agent"
Write-Host ""

# --- 1. agent reachable? ----------------------------------------------------
Step 1 'Checking the agent is up...'
try {
  $state = Invoke-RestMethod -Uri "$Agent/api/setup/state" -TimeoutSec 10
} catch {
  Bad "Cannot reach the agent at $Agent"
  Bad $_.Exception.Message
  Write-Host ""
  Write-Host '  Start it on the PC with:  "Start Agent (background).bat"' -ForegroundColor Yellow
  exit 1
}

$sessionWord = 'none'
if ($state.steps.session.ok) { $sessionWord = 'present' }
Ok "agent responding (session currently: $sessionWord)"

if (-not $state.steps.docker.ok) {
  Bad 'Docker is not running on the agent - start Docker Desktop first.'
  exit 1
}
if (-not $state.steps.rootfs.ok) {
  Bad 'rootfs/system is missing on the agent.'
  exit 1
}

# --- 2. credentials ---------------------------------------------------------
Write-Host ""
Step 2 'Credentials (password is not echoed)'
if (-not $AppleId) {
  $AppleId = Read-Host '    Apple ID (email)'
}
if ([string]::IsNullOrWhiteSpace($AppleId)) {
  Bad 'No Apple ID entered.'
  exit 1
}

$secure = Read-Host '    Password' -AsSecureString
if ($secure.Length -eq 0) {
  Bad 'No password entered.'
  exit 1
}

# --- 3. sign out (destroy the stale session) --------------------------------
Write-Host ""
Step 3 'Signing out - removing the old session...'
try {
  Invoke-RestMethod -Uri "$Agent/api/setup/signout" -Method Post -TimeoutSec 60 | Out-Null
  Ok 'old session removed'
} catch {
  Bad "Sign-out failed: $($_.Exception.Message)"
  Bad 'The container may still hold the session files open. Retry in a moment.'
  exit 1
}

# --- 4. sign in -------------------------------------------------------------
Write-Host ""
Step 4 'Signing in with the new password...'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $body  = @{ username = $AppleId; password = $plain } | ConvertTo-Json -Compress
  $plain = $null
  Invoke-RestMethod -Uri "$Agent/api/setup/login" -Method Post `
                    -ContentType 'application/json' -Body $body -TimeoutSec 180 | Out-Null
  $body = $null
  Ok 'login request accepted - the container is starting'
} catch {
  $detail = $_.ErrorDetails.Message
  if ($detail) { Bad "Login failed: $detail" } else { Bad "Login failed: $($_.Exception.Message)" }
  Write-Host ""
  Write-Host '  If your Apple ID uses two-factor auth you need an app-specific' -ForegroundColor Yellow
  Write-Host '  password from https://account.apple.com - not your normal one.' -ForegroundColor Yellow
  exit 1
} finally {
  # Wipe the plaintext copy no matter what happened above.
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  $secure.Dispose()
  Remove-Variable -Name plain, body -ErrorAction SilentlyContinue
}

# --- 5. wait for the new token ----------------------------------------------
Write-Host ""
Step 5 'Waiting for a new token to be minted...'
$done = $false
for ($i = 1; $i -le 40; $i++) {
  Start-Sleep -Seconds 3
  try {
    $s = Invoke-RestMethod -Uri "$Agent/api/setup/state" -TimeoutSec 10
    if ($s.steps.session.ok) {
      $done = $true
      Ok "session created after about $($i * 3)s"
      Ok "wrapper: running=$($s.wrapper.running) listening=$($s.wrapper.listening)"
      break
    }
  } catch { }
  if ($i % 5 -eq 0) { Write-Host "    still waiting ($($i * 3)s)" -ForegroundColor DarkGray }
}

Write-Host ""
if ($done) {
  Write-Host 'Re-authenticated successfully.' -ForegroundColor Green
  Write-Host 'The Railway UI will pick this up on its next refresh.'
} else {
  Bad 'No session appeared - the login was probably rejected.'
  Write-Host ""
  Write-Host '  Check the wrapper log for the reason:' -ForegroundColor Yellow
  Write-Host '    docker logs --tail 40 am-wrapper' -ForegroundColor Yellow
  exit 1
}
