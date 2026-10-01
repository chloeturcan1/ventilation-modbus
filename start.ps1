# Lance tout le projet en une commande sous Windows : start.bat (ou start.ps1).
#
# Equivalent Windows de start.sh, memes etapes que le tuto du README :
#   1. arrete une version deja lancee (ports 502 et 3000) ;
#   2. recupere la derniere version (git pull) et installe les dependances ;
#   3. lance l'automate et l'IHM, chacun dans sa propre fenetre, puis ouvre
#      la page dans le navigateur.
# Avec -Test (start.bat -Test), lance aussi le test automatique (client.py).
#
# Pour tout arreter : fermer les fenetres "Automate" et "IHM" (ou Ctrl+C dedans).
#
# Fichier volontairement sans accents : Windows PowerShell 5.1 lit les scripts
# sans BOM en ANSI, les accents y seraient mal affiches.

param([switch]$Test)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$PlcPort = 502
$IhmPort = 3000
$Url = "http://localhost:$IhmPort"

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Fail($text) {
    Write-Host "Erreur : $text" -ForegroundColor Red
    exit 1
}

function Test-Port($port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try { $client.Connect("127.0.0.1", $port); return $true }
    catch { return $false }
    finally { $client.Close() }
}

function Wait-Port($port, $name, $seconds) {
    for ($i = 0; $i -lt $seconds * 2; $i++) {
        if (Test-Port $port) { return }
        Start-Sleep -Milliseconds 500
    }
    Fail "$name n'a pas demarre (port $port). Regardez les messages dans sa fenetre."
}

Step "Verification des outils"
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Fail "uv n'est pas installe : https://docs.astral.sh/uv/getting-started/installation/"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "Node.js n'est pas installe : https://nodejs.org/"
}
Write-Host "uv et Node.js sont la."

Step "Arret d'une version deja lancee"
$pids = Get-NetTCPConnection -LocalPort $PlcPort, $IhmPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
if ($pids) {
    $pids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    Write-Host "Ancienne version arretee."
} else {
    Write-Host "Rien ne tournait."
}

# Les outils externes (git, uv, npm) signalent leurs erreurs par leur code de
# retour, pas par une exception PowerShell : on le verifie a chaque fois.
Step "Mise a jour depuis GitHub"
if ((Get-Command git -ErrorAction SilentlyContinue) -and (Test-Path .git)) {
    # Sans reseau ou avec des modifications locales, on continue avec la version presente.
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { Write-Host "Mise a jour impossible, on continue avec la version presente." }
} else {
    Write-Host "Pas un depot git, mise a jour ignoree."
}

Step "Installation des dependances"
uv sync --quiet
if ($LASTEXITCODE -ne 0) { Fail "uv sync a echoue." }
Push-Location ihm
# npm.cmd plutot que npm : evite le blocage de npm.ps1 par la politique d'execution.
npm.cmd install --no-audit --no-fund --loglevel=error
$npmCode = $LASTEXITCODE
Pop-Location
if ($npmCode -ne 0) { Fail "npm install a echoue." }
Write-Host "Dependances a jour."

# Chaque programme dans sa fenetre : "cmd /k" la garde ouverte apres un arret,
# pour pouvoir lire un eventuel message d'erreur.
Step "Lancement de l'automate"
Start-Process cmd -ArgumentList "/k", "title Automate && uv run server.py" -WorkingDirectory $PSScriptRoot
Wait-Port $PlcPort "L'automate" 60

Step "Lancement de l'IHM"
Start-Process cmd -ArgumentList "/k", "title IHM && npm.cmd start" -WorkingDirectory (Join-Path $PSScriptRoot "ihm")
Wait-Port $IhmPort "L'IHM" 60

Start-Process $Url

Write-Host "`nTout tourne. IHM : $Url (rechargez avec Ctrl+F5)" -ForegroundColor Green
Write-Host "Comptes : operateur / operateur, admin / admin."
Write-Host "Pour tout arreter : fermez les fenetres Automate et IHM."

if ($Test) {
    Step "Test automatique"
    uv run client.py
}
