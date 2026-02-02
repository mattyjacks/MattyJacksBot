#!/bin/bash
set -e

echo "=== Moltbook + OpenClaw Bootstrap for Vast.ai ==="
echo ""

# Update package lists
echo "[1/7] Updating packages..."
apt-get update -qq

# Install dependencies
echo "[2/7] Installing dependencies..."
apt-get install -y -qq git curl python3 python3-pip tmux

# Check Node version and upgrade if needed
echo "[3/7] Checking Node.js..."
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1 || echo "0")
if [ "$NODE_VERSION" -lt "22" ]; then
  echo "    Upgrading Node.js to v22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    Node.js $(node -v)"

# Install Ollama
echo "[4/7] Installing Ollama..."
if ! command -v ollama &> /dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi

# Start Ollama service
echo "[5/7] Starting Ollama..."
pkill ollama 2>/dev/null || true
nohup ollama serve > /tmp/ollama.log 2>&1 &
sleep 3

# Install OpenClaw
echo "[6/7] Installing OpenClaw..."
if ! command -v openclaw &> /dev/null; then
  npm install -g openclaw@latest
fi
echo "    OpenClaw $(openclaw --version 2>/dev/null || echo 'installed')"

# Create directories
echo "[7/7] Creating workspace..."
mkdir -p ~/.openclaw/workspace/skills
mkdir -p ~/moltbook/v1/sync/public
mkdir -p ~/moltbook/v1/sync/private
mkdir -p ~/moltbook/v1/sync/artifacts
mkdir -p ~/moltbook/v1/sync/state

# Create minimal OpenClaw config if not exists
if [ ! -f ~/.openclaw/openclaw.json ]; then
  cat > ~/.openclaw/openclaw.json << 'EOF'
{
  "agent": {
    "model": "ollama/qwen3-coder"
  },
  "agents": {
    "defaults": {
      "workspace": "~/moltbook/v1/agent_runtime/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "gateway": {
    "mode": "local"
  }
}
EOF
fi

echo ""
echo "=== Bootstrap Complete ==="
echo ""
echo "Next steps:"
echo "  1. Pull a model:  ollama pull qwen3-coder:7b-q4_K_M"
echo "  2. Start gateway: openclaw gateway run --port 18789"
echo ""
