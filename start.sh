#!/usr/bin/env bash
# Lance tout le projet en une commande : ./start.sh
#
# Fait les mêmes étapes que le tuto du README (voir « Tester le projet ») :
#   1. arrête une version déjà lancée (ports 502 et 3000) ;
#   2. récupère la dernière version (git pull) et installe les dépendances ;
#   3. lance l'automate puis l'IHM, et ouvre la page dans le navigateur.
# Avec ./start.sh --test, lance aussi le test automatique (client.py).
#
# Les messages de l'automate et de l'IHM s'affichent ici, préfixés.
# Ctrl+C arrête tout.

set -euo pipefail
cd "$(dirname "$0")"

PLC_PORT=502
IHM_PORT=3000
URL="http://localhost:$IHM_PORT"
RUN_TEST=false
[[ "${1:-}" == "--test" ]] && RUN_TEST=true

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31mErreur : %s\033[0m\n' "$1" >&2; exit 1; }

# Préfixe chaque ligne, sans mise en tampon, pour distinguer les deux programmes.
prefix() { awk -v p="$1" '{ print p " " $0; fflush() }'; }

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

wait_port() { # port, nom, délai max en secondes
  for _ in $(seq 1 $(($3 * 5))); do
    port_open "$1" && return 0
    sleep 0.2
  done
  fail "$2 n'a pas démarré (port $1). Regarde les messages au-dessus."
}

step "Vérification des outils"
command -v uv >/dev/null || fail "uv n'est pas installé : https://docs.astral.sh/uv/getting-started/installation/"
command -v npm >/dev/null || fail "Node.js n'est pas installé : https://nodejs.org/"
echo "uv et Node.js sont là."

listeners() { lsof -ti "tcp:$PLC_PORT,$IHM_PORT" -sTCP:LISTEN 2>/dev/null || true; }

step "Arrêt d'une version déjà lancée"
pids=$(listeners)
if [[ -n "$pids" ]]; then
  kill $pids 2>/dev/null || true
  sleep 1
  echo "Ancienne version arrêtée."
else
  echo "Rien ne tournait."
fi

step "Mise à jour depuis GitHub"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  # Sans réseau ou avec des modifications locales, on continue avec la version présente.
  git pull --ff-only || echo "Mise à jour impossible, on continue avec la version présente."
else
  echo "Pas un dépôt git, mise à jour ignorée."
fi

step "Installation des dépendances"
uv sync --quiet
(cd ihm && npm install --no-audit --no-fund --loglevel=error)
echo "Dépendances à jour."

# Ctrl+C ou fin du script : arrête l'automate et l'IHM lancés ici. Les programmes
# lancés en arrière-plan par un script ignorent Ctrl+C : on les arrête par leur port.
cleanup() {
  trap - INT TERM EXIT
  printf '\nArrêt de l'"'"'automate et de l'"'"'IHM...\n'
  pids=$(listeners)
  [[ -n "$pids" ]] && kill $pids 2>/dev/null
  wait 2>/dev/null || true
  echo "Tout est arrêté."
}
trap cleanup INT TERM EXIT

step "Lancement de l'automate"
PYTHONUNBUFFERED=1 uv run server.py 2>&1 | prefix "[automate]" &
wait_port "$PLC_PORT" "L'automate" 20

step "Lancement de l'IHM"
(cd ihm && npm start --silent 2>&1 | prefix "[ihm]     ") &
wait_port "$IHM_PORT" "L'IHM" 30

if command -v open >/dev/null; then
  open "$URL"
elif command -v xdg-open >/dev/null; then
  xdg-open "$URL" >/dev/null 2>&1
fi

printf '\n\033[32mTout tourne.\033[0m IHM : %s (recharge avec Cmd+Shift+R)\n' "$URL"
echo "Comptes : operateur / operateur, admin / admin."
echo "Ctrl+C pour tout arrêter."

if $RUN_TEST; then
  step "Test automatique"
  PYTHONUNBUFFERED=1 uv run client.py 2>&1 | prefix "[test]    " || true
fi

wait
