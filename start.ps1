$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Records Search ===" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command deno -ErrorAction SilentlyContinue)) {
    Write-Host "Deno n'est pas installé." -ForegroundColor Red
    Write-Host ""
    Write-Host "Télécharge-le ici :" -ForegroundColor Yellow
    Write-Host "https://deno.com/runtime"
    Write-Host ""
    Pause
    exit 1
}

if (-not (Test-Path "server.ts")) {
    Write-Host "❌ server.ts introuvable dans ce dossier." -ForegroundColor Red
    Pause
    exit 1
}

if (-not (Test-Path "records.sqlite")) {
    Write-Host "❌ records.sqlite introuvable dans ce dossier." -ForegroundColor Red
    Pause
    exit 1
}

$PORT = 8787
$URL = "http://localhost:$PORT"

Write-Host "Base de données : records.sqlite"
Write-Host "Serveur : $URL"
Write-Host ""

Start-Job {
    Start-Sleep -Seconds 2
    Start-Process $using:URL
} | Out-Null

deno run -A server.ts --db records.sqlite --port $PORT
