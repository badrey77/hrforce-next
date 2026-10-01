# Starts HRForce Next locally from PowerShell (Windows PowerShell 5.1 or PowerShell 7):
# Postgres + Mailpit (Docker Desktop), migrations, demo seed, then the API, the background worker (notification
# e-mails, cron), the web app and the SSO demo sister app (apps/sso-demo, http://localhost:4300) in four new windows.
#
# Usage (repo root):
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev-up.ps1          # start
#   powershell -ExecutionPolicy Bypass -File .\scripts\dev-up.ps1 -Reset   # wipe the database first
# Stop: close the four windows (or Ctrl+C in them); `cd apps\api; docker compose down` stops the database.
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
if (-not (Test-Path 'apps\sso-demo\.env')) {
  Step 'Creating apps\sso-demo\.env from .env.example'
  Copy-Item 'apps\sso-demo\.env.example' 'apps\sso-demo\.env'
}
# An .env created before the worker existed: add its settings from .env.example.
if (-not (Select-String -Path 'apps\api\.env' -Pattern '^WORKER_DATABASE_URL=' -Quiet)) {
  Step 'Adding the worker settings (WORKER_DATABASE_URL, WORKER_CONCURRENCY) to apps\api\.env'
  $workerLines = Select-String -Path 'apps\api\.env.example' -Pattern '^(WORKER_DATABASE_URL|WORKER_CONCURRENCY)=' | ForEach-Object { $_.Line }
  Add-Content -Path 'apps\api\.env' -Value (@('') + $workerLines)
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
  # A database volume created before migration 0012 has no hrforce_worker role (the init hook only runs on an empty
  # volume): create it with the development password of .env.example.
  $createWorker = "do `$`$ begin if not exists (select from pg_roles where rolname = 'hrforce_worker') then " +
    "create role hrforce_worker login nosuperuser nocreatedb nocreaterole nobypassrls password 'hrforce_worker_dev'; end if; end `$`$"
  Invoke-Checked 'create hrforce_worker' { docker compose exec -T postgres psql -q -U postgres -v ON_ERROR_STOP=1 -c $createWorker }
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
Step 'Building the SSO demo sister app'
Invoke-Checked 'build sso-demo' { npm run build -w '@hrforce/sso-demo' }

# --- API, worker, web and SSO demo in their own windows ---------------------------------------------------------
Step 'Starting the API (http://localhost:3000), the worker, the web app (http://localhost:4200) and the SSO demo (http://localhost:4300) in new windows'
$shell = (Get-Process -Id $PID).Path   # the same PowerShell that runs this script
Start-Process -FilePath $shell -WorkingDirectory $root -ArgumentList @(
  '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle = 'HRForce API'; npm start -w '@hrforce/api'")
# Background jobs (Graphile Worker): notification e-mails and the monthly/daily cron. Built by seed:dev above.
Start-Process -FilePath $shell -WorkingDirectory $root -ArgumentList @(
  '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle = 'HRForce Worker'; npm run start:worker -w '@hrforce/api'")
# PORT (3000, loaded from apps\api\.env above) would override `ng serve --port 4200`: the Angular dev server reads
# process.env.PORT first and would take the API's port. The web window gets its own PORT.
Start-Process -FilePath $shell -WorkingDirectory $root -ArgumentList @(
  '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle = 'HRForce Web'; `$env:PORT = '4200'; npm start -w '@hrforce/web'")
# SSO demo sister app: reads apps\sso-demo\.env (SSO_DEMO_PORT=4300; the API's PORT is removed, the demo does not use
# it). It waits for HRForce's OpenID discovery (through the web dev server's /oidc proxy), retrying for 60 s.
Start-Process -FilePath $shell -WorkingDirectory $root -ArgumentList @(
  '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle = 'HRForce SSO demo'; Remove-Item Env:PORT -ErrorAction SilentlyContinue; npm start -w '@hrforce/sso-demo'")

Write-Host @'

  Open http://localhost:4200 once the web window says "Local: http://localhost:4200/".
  Password for every demo user: demo-password-2026
    rh.admin@demo.dz       central HR admin (everything, salaries, Access screens)
    rh.est@demo.dz         regional HR, Region Est (Arabic UI)
    lecture.ouest@demo.dz  read-only, Region Ouest
  Mails (password links, notification e-mails sent by the worker): http://localhost:8025
  SSO demo: http://localhost:4300 - agent.annaba@demo.dz (Operateur), chef.annaba@demo.dz (Superviseur), rh.est@demo.dz (aucun role, arabe)
  Stop: close the "HRForce API", "HRForce Worker", "HRForce Web" and "HRForce SSO demo" windows; cd apps\api; docker compose down

'@
