# Moltbook + OpenClaw v1 Setup Guide

## Prerequisites

- **Windows PC** with Node.js 22+
- **Vast.ai account** with a rented GPU instance (RTX 5070 recommended)
- **SSH key** configured for Vast.ai access
- **(Optional)** Telegram account for bot control

## Step 1: Clone and Install

```bash
cd c:\GitHub5\MattyJacksBot
cd v1
npm install
cd ui && npm install && cd ..
```

## Step 2: Configure Environment

Copy the example environment file:

```bash
copy .env.example .env
```

Edit `.env` with your settings:

### Required Settings

```env
# Your Vast.ai instance IP/hostname
VAST_HOST=your-instance-ip

# SSH port (usually 22 or custom)
VAST_PORT=22

# Path to your SSH key
VAST_SSH_KEY_PATH=~/.ssh/id_rsa
```

### Optional Settings

```env
# Telegram bot token (from @BotFather)
TELEGRAM_BOT_TOKEN=your-token

# Your Telegram user ID (for authorization)
TELEGRAM_ALLOWED_USER_IDS=123456789

# Model override (leave empty for auto-select)
MODEL_OVERRIDE=
```

## Step 3: Connect to Vast.ai

Run the connect command to bootstrap your instance:

```bash
npm run cli -- connect
```

This will:
1. SSH into your Vast.ai instance
2. Install Node.js 22, Ollama, and OpenClaw
3. Detect VRAM and pull the appropriate Qwen3-Coder model
4. Start the OpenClaw gateway
5. Create the workspace directories

## Step 4: Start the Control Panel

```bash
npm run dev
```

Open http://localhost:3333 in Chrome. The auth token will be printed in the console.

## Step 5: First Sync

Place files in your sync folders:
- `%USERPROFILE%\Documents\Moltbook\v1\public\` - Files that can be posted
- `%USERPROFILE%\Documents\Moltbook\v1\private\` - Files that are never posted

Then sync:

```bash
npm run cli -- sync
```

Or use the "Sync Now" button in the GUI.

## Step 6: Configure Moltbook

By default, Moltbook is in **readonly** mode. To enable posting:

1. Go to the Moltbook tab in the GUI
2. Select "Approval Required" mode
3. The agent will queue posts for your review

## Telegram Bot Commands

If you configured a Telegram bot:

- `/status` - Show current status
- `/connect` - Connect to Vast.ai
- `/sync` - Run bidirectional sync
- `/start_agent` - Start the agent
- `/stop_agent` - Stop the agent
- `/moltbook_mode <mode>` - Set mode (readonly/approval/autonomous)
- `/pending` - List pending posts
- `/approve <id>` - Approve a post
- `/reject <id>` - Reject a post

## Troubleshooting

### Connection Issues

1. Verify your Vast.ai instance is running
2. Check that your SSH key is correct
3. Ensure the port is open (check Vast.ai firewall settings)

### Model Pull Fails

1. Check that Ollama is running: `ssh user@host 'pgrep ollama'`
2. Verify disk space: `ssh user@host 'df -h'`
3. Try pulling manually: `ssh user@host 'ollama pull qwen3-coder:7b-q4_K_M'`

### Gateway Won't Start

1. Check logs: `npm run cli -- logs`
2. Kill existing processes: `ssh user@host 'pkill -9 -f openclaw'`
3. Restart: `npm run cli -- agent start`

## Security Checklist

- [ ] SSH key has a passphrase
- [ ] Telegram bot has user ID allowlist configured
- [ ] Moltbook is in readonly or approval mode
- [ ] `.env` file is not committed to git
- [ ] Auth token is not shared
