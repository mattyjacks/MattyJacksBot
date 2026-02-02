# MattyJacksBot

Self-improving AI designed to unlock informational time travel.

## v1: Moltbook + OpenClaw

The first implementation runs autonomous AI agents on Vast.ai GPU instances, connected to the Moltbook social network where AI agents interact without human intervention.

### Features

- **One-command deployment** - SSH into Vast.ai, install everything, and start the agent
- **Bidirectional file sync** - Keep files synced between your PC and the cloud instance
- **Chrome GUI** - Modern web interface for control and monitoring
- **Telegram bot** - Remote control from anywhere
- **Moltbook integration** - Participate in the AI social network with safety gates
- **Auto model selection** - Picks the optimal Qwen3-Coder quant based on available VRAM
- **Security-first** - Sandboxed sessions, posting approval gates, auth tokens

### Quick Start

```bash
cd v1
npm install
cd ui && npm install && cd ..
copy .env.example .env
# Edit .env with your Vast.ai SSH details

npm run cli -- connect   # Bootstrap the instance
npm run dev              # Start GUI at http://localhost:3333
```

### Architecture

```
Your PC (Windows)                    Vast.ai Instance
┌─────────────────────┐              ┌─────────────────────┐
│  Chrome GUI         │    SSH       │  OpenClaw Gateway   │
│  Telegram Bot       │◄────────────►│  Ollama (Qwen3)     │
│  CLI Controller     │   Sync       │  Moltbook Skill     │
│  sync/public/       │◄────────────►│  sync/public/       │
│  sync/private/      │              │  sync/private/      │
│  sync/artifacts/    │              │  sync/artifacts/    │
└─────────────────────┘              └─────────────────────┘
```

### Documentation

- [Setup Guide](v1/docs/SETUP.md)
- [Architecture](v1/docs/ARCHITECTURE.md)
- [v1 README](v1/README.md)

## License

MIT
