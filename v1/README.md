# Moltbook + OpenClaw v1

Self-improving AI control system that runs OpenClaw agents on Vast.ai with bidirectional file sync and Moltbook integration.

## Features

- **One-command SSH bootstrap** - Connect to Vast.ai and set up everything automatically
- **Bidirectional file sync** - Keep local and remote files in sync with conflict handling
- **Chrome GUI** - Modern web interface for configuration and control
- **Telegram bot** - Remote control via Telegram
- **Moltbook integration** - Post to the AI social network with safety gates
- **Auto model selection** - Picks the right Qwen3-Coder quant based on VRAM
- **Security-first** - Sandboxed sessions, approval gates, and safe defaults

## Quick Start

### 1. Install dependencies

```bash
cd v1
npm install
cd ui && npm install && cd ..
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your Vast.ai SSH details and Telegram token
```

### 3. Connect to Vast.ai

```bash
npm run cli -- connect
```

This will:
- SSH into your Vast.ai instance
- Install Node.js, Ollama, and OpenClaw
- Pull the appropriate Qwen3-Coder model based on VRAM
- Start the OpenClaw gateway
- Set up the workspace

### 4. Run the GUI

```bash
npm run dev
```

Open http://localhost:3333 in Chrome.

## CLI Commands

```bash
# Connect and bootstrap Vast.ai instance
npm run cli -- connect

# Bidirectional sync
npm run cli -- sync

# Check status
npm run cli -- status

# View logs
npm run cli -- logs

# Start/stop agent
npm run cli -- agent start
npm run cli -- agent stop
```

## Folder Structure

```
v1/
├── controller/          # CLI and web server
│   ├── cli.js          # Command-line interface
│   ├── server.js       # Express server for GUI
│   ├── ssh.js          # SSH connection utilities
│   ├── sync.js         # Bidirectional sync logic
│   └── telegram.js     # Telegram bot integration
├── ui/                  # React + Tailwind GUI
├── sync/               # Local sync folders
│   ├── public/         # Files that can be posted to Moltbook
│   ├── private/        # Files synced but never posted
│   ├── artifacts/      # Downloaded outputs from agent
│   └── state/          # Sync state and checkpoints
├── agent_runtime/      # OpenClaw workspace templates
├── scripts/            # Vast.ai bootstrap scripts
└── docs/               # Documentation
```

## Security

- **Moltbook is read-only by default** - Enable posting via GUI or Telegram
- **Non-main sessions are sandboxed** - Moltbook runs in isolation
- **Approval required for posts** - No uncontrolled posting
- **Skills are allowlisted** - Only trusted skills can be installed
- **Auth token for GUI** - Generated on first run

## Sync Behavior

- **Conflict policy**: Newest file wins, overwritten files are backed up
- **Public folder**: Content eligible for Moltbook posting
- **Private folder**: Synced but never posted
- **Artifacts folder**: Agent outputs, logs, and receipts

## License

MIT
