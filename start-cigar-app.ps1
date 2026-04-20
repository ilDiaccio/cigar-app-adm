$ErrorActionPreference = "Stop"

$appRoot = $PSScriptRoot
$appUrl = "http://localhost:3000/"
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue

function Pause-OnError {
  param(
    [string]$Message
  )

  Write-Host ""
  Write-Host $Message -ForegroundColor Red
  Write-Host ""
  Read-Host "Premi INVIO per chiudere"
  exit 1
}

function Test-AppRunning {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "${appUrl}api/status" -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

if (-not $nodeCmd -or -not $npmCmd) {
  Pause-OnError "Node.js e npm non risultano installati. Installa Node.js da https://nodejs.org/ e poi rilancia questo file."
}

Set-Location -LiteralPath $appRoot

if (-not (Test-Path -LiteralPath (Join-Path $appRoot "node_modules"))) {
  Write-Host "Installazione dipendenze..." -ForegroundColor Yellow
  & $npmCmd.Source install
  if ($LASTEXITCODE -ne 0) {
    Pause-OnError "Installazione dipendenze non riuscita."
  }
}

if (-not (Test-AppRunning)) {
  Write-Host "Avvio server..." -ForegroundColor Yellow
  $escapedRoot = $appRoot.Replace("'", "''")
  $serverCommand = "Set-Location -LiteralPath '$escapedRoot'; npm start"
  Start-Process powershell -WorkingDirectory $appRoot -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    $serverCommand
  ) | Out-Null

  $started = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-AppRunning) {
      $started = $true
      break
    }
  }

  if (-not $started) {
    Pause-OnError "Il server non risponde sulla porta 3000. Controlla la finestra del server per eventuali errori."
  }
}

Write-Host "Apro l'app nel browser..." -ForegroundColor Green
Start-Process $appUrl
