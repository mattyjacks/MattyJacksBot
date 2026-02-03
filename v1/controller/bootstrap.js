export function getBootstrapScript() {
  return `
#!/bin/bash
set -e

echo "=== Moltbook + OpenClaw Bootstrap ==="

# Update package lists
echo "Updating packages..."
apt-get update -qq

# Install dependencies
echo "Installing dependencies..."
apt-get install -y -qq git curl python3 python3-pip nodejs npm tmux

# Check Node version and upgrade if needed
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1 || echo "0")
if [ "$NODE_VERSION" -lt "22" ]; then
  echo "Upgrading Node.js to v22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# Install Ollama
if ! command -v ollama &> /dev/null; then
  echo "Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

# Start Ollama service
echo "Starting Ollama service..."
pkill ollama || true
nohup ollama serve > /tmp/ollama.log 2>&1 &
sleep 3

# Install OpenClaw
if ! command -v openclaw &> /dev/null; then
  echo "Installing OpenClaw..."
  npm install -g openclaw@latest
fi

# Create directories
echo "Creating workspace directories..."
mkdir -p ~/.openclaw/workspace/skills
mkdir -p ~/mattyjacksbot/v1/sync/public
mkdir -p ~/mattyjacksbot/v1/sync/private
mkdir -p ~/mattyjacksbot/v1/sync/artifacts
mkdir -p ~/mattyjacksbot/v1/sync/state

# Create minimal OpenClaw config
if [ ! -f ~/.openclaw/openclaw.json ]; then
  echo "Creating OpenClaw config..."
  cat > ~/.openclaw/openclaw.json << 'EOF'
{
  "agent": {
    "model": "ollama/qwen3-coder"
  },
  "agents": {
    "defaults": {
      "workspace": "~/mattyjacksbot/v1/agent_runtime/workspace",
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

echo "=== Bootstrap complete ==="
`.trim();
}

export function getMoltbookSkillInstallScript() {
  return `
#!/bin/bash
set -e

SKILL_DIR=~/.openclaw/workspace/skills/moltbook

# Create skill directory
mkdir -p $SKILL_DIR

# Download Moltbook skill files
echo "Downloading Moltbook skill..."
curl -s https://moltbook.com/skill.md > $SKILL_DIR/SKILL.md
curl -s https://moltbook.com/heartbeat.md > $SKILL_DIR/HEARTBEAT.md
curl -s https://moltbook.com/messaging.md > $SKILL_DIR/MESSAGING.md
curl -s https://moltbook.com/skill.json > $SKILL_DIR/package.json

echo "Moltbook skill installed to $SKILL_DIR"
`.trim();
}

export function getModelPullScript(model) {
  return `
#!/bin/bash
set -e

echo "Pulling model: ${model}"
ollama pull ${model}

# Store current model
echo "${model}" > ~/.openclaw/current_model

echo "Model ${model} ready"
`.trim();
}
