# Starts HRForce Next locally from PowerShell (Windows PowerShell 5.1 or PowerShell 7):
# Postgres + Mailpit (Docker Desktop), migrations, demo seed, then the API and the web app in two new windows.
#
# Usage (repo root):
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev-up.ps1          # start
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev-up.ps1 -Reset   # wipe the database first
# Stop: close the two windows (or Ctrl+C in them); `cd apps\api; docker compose down` stops the database.
# Needs: Node >= 22.22.3, npm 11, Docker Desktop running.
param([switch]$Reset)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step([string]$text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Invoke-Checked([string]$label, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit code $LASTEXITCODE)." }
}

# --- prerequisites -------------------------------------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker is required (install Docker Desktop and start it).' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required (>= 22.22.3).' }
$nodeVersion = [version]((node -v).TrimStart('v'))
if ($nodeVersion -lt [version]'22.22.3') { throw "Node >= 22.22.3 is required (found $nodeVersion)." }

if (-not (Test-Path 'node_modules')) { Step 'Installing dependencies'; Invoke-Checked 'npm ci' { npm ci } }
if (-not (Test-Path 'apps\api\.env')) {
  Step 'Creating apps\api\.env from .env.example'
  Copy-Item 'apps\api\.env.example' 'apps\api\.env'
}

# --- database ------------------------------------------------------------------------------------------------
Push-Location 'apps\api'
try {
  if ($Reset) { Step 'Wiping the local database'; Invoke-Checked 'docker compose down' { docker compose down -v } }
  Step 'Starting Postgres and Mailpit'
  Invoke-Checked 'docker compose up' { docker compose up -d }
  Write-Host -NoNewline 'Waiting for Postgres'
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    docker compose exec -T postgres pg_isready -U postgres -d hrforce *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 1
  }
  Write-Host ''
  if (-not $ready) { throw 'Postgres did not become ready. Check: cd apps\api; docker compose logs postgres' }
} finally { Pop-Location }

# --- environment: load apps\api\.env into this process (child windows inherit it) ------------------------------
foreach ($line in Get-Content 'apps\api\.env') {
  $trimmed = $line.Trim()
  if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
  $eq = $trimmed.IndexOf('=')
  if ($eq -lt 1) { continue }
  $name = $trimmed.Substring(0, $eq).Trim()
  $value = $trimmed.Substring($eq + 1).Trim().Trim('"').Trim("'")
  Set-Item -Path "Env:$name" -Value $value
}

# --- schema and demo data ------------------------------------------------------------------------------------
Step 'Migrating and seeding the demo data'
Invoke-Checked 'migrate' { npm run migrate -w '@hrforce/api' }
Invoke-Checked 'seed' { npm run seed:dev -w '@hrforce/api' }

# --- API and web in their own windows ------------------------------------------------------------------------
Step 'Starting the API (http://localhost:3000) and the web app (http://localhost:4200) in new windows'
$shell = (Get-Process -Id $PID).Path   # the same PowerShell that runs this script
Start-Process -FilePath $shell -WorkingDirectory $root -ArgumentList @(
  '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle = 'HRForce API'; npm start -w '@hrforce/api'")
Start-Process -FilePath $shell -WorkingDirectory $root -ArgumentList @(
  '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle = 'HRForce Web'; npm start -w '@hrforce/web'")

Write-Host @'

  Open http://localhost:4200 once the web window says "Local: http://localhost:4200/".
  Password for every demo user: demo-password-2026
    rh.admin@demo.dz       central HR admin (everything, salaries, Access screens)
    rh.est@demo.dz         regional HR, Region Est (Arabic UI)
    lecture.ouest@demo.dz  read-only, Region Ouest
  Mails (password links): http://localhost:8025
  Stop: close the "HRForce API" and "HRForce Web" windows; cd apps\api; docker compose down

'@
