#!/bin/bash

################################################################################
# AI Runner Server — Deploy Script
#
# Uso:
#   ./deploy.sh "mensaje del commit"
#
# Qué hace:
#   1. Commit de cambios locales con el mensaje dado
#   2. Push a GitHub (lordmacu/aiextension-server)
#   3. Pull en el servidor remoto
#   4. Restart de PM2 (aiextension-server)
################################################################################

set -e

# ── Colores ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()     { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Config ────────────────────────────────────────────────────────────────────
SERVER_HOST=100.24.49.190
SERVER_PORT=22
SERVER_USER=bitnami
SERVER_REPO=/home/bitnami/aiextension
SERVER_PATH=/home/bitnami/aiextension/test-server
SSH_KEY=/Users/cristian/finearom/finearom.pem
GITHUB_USER=lordmacu
GITHUB_TOKEN=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
PM2_PROCESS=aiextension-server

COMMIT_MSG="${1:-"deploy: $(date '+%Y-%m-%d %H:%M:%S')"}"

# ── Validaciones ──────────────────────────────────────────────────────────────
[ ! -f "$SSH_KEY" ] && error "Llave SSH no encontrada: $SSH_KEY"
[ ! -d ".git" ]     && error "No es un repositorio Git. Ejecuta desde /Users/cristian/aiextension-server"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║        AI Runner Server — Deploy         ║"
echo "╚══════════════════════════════════════════╝"
echo ""
log "Commit: $COMMIT_MSG"
log "Servidor: $SERVER_USER@$SERVER_HOST:$SERVER_PATH"
echo ""

# ── SSH helper ────────────────────────────────────────────────────────────────
ssh_exec() {
    ssh -T -i "$SSH_KEY" -p "$SERVER_PORT" \
        -o LogLevel=ERROR \
        -o StrictHostKeyChecking=no \
        "$SERVER_USER@$SERVER_HOST" "$@"
}

# ── 1. Probar conexión SSH ────────────────────────────────────────────────────
log "Probando conexión SSH..."
ssh_exec "echo OK" > /dev/null 2>&1 || error "No se pudo conectar al servidor"
success "Conexión SSH OK"

# ── 2. Commit local ───────────────────────────────────────────────────────────
log "Verificando cambios locales..."
if git diff-index --quiet HEAD -- 2>/dev/null; then
    warning "Sin cambios para commitear — se hará push del estado actual"
else
    git add .
    git commit -m "$COMMIT_MSG"
    success "Commit creado"
fi

# ── 3. Push a GitHub ──────────────────────────────────────────────────────────
log "Push a GitHub..."
BRANCH=$(git branch --show-current)

# Credenciales temporales
CRED_FILE=$(mktemp)
echo "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com" > "$CRED_FILE"
git config credential.helper "store --file=$CRED_FILE"

git push origin "$BRANCH" || { rm -f "$CRED_FILE"; git config --unset credential.helper; error "Push falló"; }

rm -f "$CRED_FILE"
git config --unset credential.helper
success "Push OK → branch: $BRANCH"

# ── 4. Pull en servidor ───────────────────────────────────────────────────────
log "Actualizando servidor..."
ssh_exec "
    cd '$SERVER_REPO'
    git remote set-url origin 'https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/aiextension-server.git'
    git fetch origin $BRANCH
    git reset --hard origin/$BRANCH
    # Copiar server.js al directorio con node_modules
    cp server.js '$SERVER_PATH/server.js'
    echo 'Pull OK'
"
success "Código actualizado en servidor"

# ── 5. Restart PM2 ───────────────────────────────────────────────────────────
log "Reiniciando PM2 ($PM2_PROCESS)..."
ssh_exec "pm2 restart $PM2_PROCESS --silent && sleep 1 && pm2 show $PM2_PROCESS | grep 'status'"
success "PM2 reiniciado"

# ── Resumen ───────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║          ✅ DEPLOY EXITOSO               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
success "Servidor actualizado y corriendo"
echo ""
