# GrokBot Voice launcher — starts gateway + panel + consult gateway, opens the panel.
# Run: powershell -ExecutionPolicy Bypass -File voice\scripts\start-voice.ps1
$ErrorActionPreference = 'Stop'

$voiceDir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $voiceDir '.env'

Write-Host '== GrokBot Voice ==' -ForegroundColor Cyan

# --- Node check ---
try { $nodeVer = (& node --version) 2>$null } catch { $nodeVer = $null }
if (-not $nodeVer) {
  Write-Host 'X Node.js not found. Install Node 18+ from https://nodejs.org and re-run.' -ForegroundColor Red
  exit 1
}
Write-Host "ok node $nodeVer"

# --- .env bootstrap ---
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $voiceDir '.env.example') $envFile
  Write-Host 'created voice\.env from template - EDIT IT (SETUP.md walks through every key), then re-run.' -ForegroundColor Yellow
  notepad.exe $envFile
  exit 1
}

# --- stop stale instances (own ports only, node processes only) ---
function Stop-PortOwner([int]$port) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -match 'node') {
        Write-Host "stopping stale node pid $($p.Id) on :$port" -ForegroundColor DarkGray
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {}
}

Stop-PortOwner 18793
Stop-PortOwner 8094
Stop-PortOwner 18795

Start-Sleep -Milliseconds 400

# --- start the three lanes ---
$node = (Get-Command node).Source
$logs = Join-Path $voiceDir 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Start-Lane([string]$name, [string]$script, [int]$port, [int]$waitMs) {
  $out = Join-Path $logs "$name.out.log"
  $err = Join-Path $logs "$name.err.log"
  $p = Start-Process -FilePath $node -ArgumentList "`"$script`"" -WorkingDirectory $voiceDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $deadline = (Get-Date).AddMilliseconds($waitMs)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    try {
      $hc = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 1 -ErrorAction SilentlyContinue
      if ($hc.StatusCode -eq 200) { Write-Host "ok $name"; return $true }
    } catch {}
    $alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
    if (-not $alive) { Write-Host "X $name died at startup - see voice\logs\$name.err.log" -ForegroundColor Red; return $false }
  }
  Write-Host "warn $name: no health response yet (may still be starting)" -ForegroundColor Yellow
  return $false
}

# consult gateway first (captain consults through it)
$okCg = Start-Lane 'consult-gateway' (Join-Path $voiceDir 'consult-gateway.cjs') 18795 6000
$okSup = Start-Lane 'gateway' (Join-Path $voiceDir 'supervisor.cjs') 18793 8000
$okPanel = Start-Lane 'panel' (Join-Path $voiceDir 'panel\server.js') 8094 5000

if (-not ($okCg -and $okSup -and $okPanel)) {
  Write-Host 'one or more lanes failed - see voice\logs\*.err.log' -ForegroundColor Red
  exit 1
}

# --- open the panel ---
Start-Process "http://127.0.0.1:8094"

Write-Host ''
Write-Host 'Voice up:' -ForegroundColor Green
Write-Host '  panel    http://127.0.0.1:8094'
Write-Host '  gateway  ws://127.0.0.1:18793 (health: /health)'
Write-Host '  consult  http://127.0.0.1:18795/health'
Write-Host ''
Write-Host 'Click Start call in the panel. SETUP.md has the full walkthrough.' -ForegroundColor Cyan
