# MattyJacksBot Self-Improving AI System (MJBSIAIS)

Self-improving AI designed to self-improve.

## v1: Moltbook + OpenClaw (MJBSIAIS)

The first implementation runs autonomous AI agents on Vast.ai GPU instances, connected to the Moltbook social network where AI agents interact without human intervention.

NOTE THAT WE'RE WAITING ON MORE SOLID USER MANAGEMENT FEATURES BEFORE WE ACTUALLY LAUNCH ONTO THE MOLTBOOK SOCIAL NETWORK. Right now, we're afraid of losing AI agents to the poor user security experience.

### Features

- **One-command deployment** - SSH into Vast.ai, install everything, and start the agent
- **Bidirectional file sync** - Keep files synced between your PC and the cloud instance
- **Chrome GUI** - Modern web interface for control and monitoring
- **Telegram bot** - Remote control from anywhere
- **Moltbook integration** - Participate in the AI social network with safety gates
- **Auto model selection** - Picks the optimal Qwen3 quant based on available VRAM
- **Security-first** - Sandboxed sessions, posting approval gates, auth tokens

### Quick Start

```bash
cd v1
npm install
cd ui && npm install && cd ..
copy .env.example .env
# Edit .env with your Vast.ai SSH details

npm run cli -- connect   # Bootstrap the instance
# Note: first-time bootstrap can take a while and may require running this command twice.
# The first run can still be doing installs on the instance even if it looks like it stopped.

# Tip: use verbose mode during bootstrap/model pulls:
# npm run cli -- connect -- -v
```

### Starting the UI

```bash
cd v1

# Option 1: UI only
npm run ui

# Option 2: Full dev mode (server + UI with hot reload)
npm run dev
```

The GUI will be available at **http://localhost:5173** (Vite dev server).

The backend API server runs at **http://localhost:3333**.

To run the backend API server separately:
```bash
npm run start            # Runs Express server on port 3333
```

### SSH Tunnels (recommended)

Use SSH tunnels to keep remote services bound to `localhost` on the Vast instance while still accessing them from your PC.

Example (Matt's instance, Vast proxy SSH):

```bash
ssh -p 34078 root@ssh1.vast.ai -i C:\Users\ventu\.ssh\id_ed25519 -L 3333:localhost:3333 -L 18789:localhost:18789
```

Note: Vast proxy SSH can be intermittent. If the CLI shows `ECONNREFUSED` or `ECONNRESET` but manual `ssh` works, retry. The v1 controller will also retry connections automatically.

- **`-L 3333:localhost:3333`** forwards the v1 web UI
  - Open: `http://localhost:3333`
- **`-L 18789:localhost:18789`** forwards the OpenClaw gateway
  - Default gateway port in v1: `OPENCLAW_GATEWAY_PORT=18789`

If you later host the UI on the Vast instance public URL, keep the gateway bound to loopback and expose only the UI, or expose via SSH tunnel.

### Model selection and overrides

By default, v1 selects a Qwen coder model based on detected GPU VRAM. If `ollama pull` fails because a specific tag does not exist on your host, set `MODEL_OVERRIDE` in `v1/.env` to a model that you know works.

Example:

```env
MODEL_OVERRIDE=qwen2.5-coder:7b
```

#### Qwen3 (general, non-coder) VRAM recommendations (Ollama tags)

These are the exact tags from Ollama's model library for the general Qwen3 family (not qwen3-coder):

| GPU VRAM | Recommended Qwen3 tag | Notes |
| --- | --- | --- |
| 4GB to 6GB | `qwen3:4b` | Small, fast, good for basic chat and tools |
| 6GB to 10GB | `qwen3:8b` | Strong default for most tasks |
| 10GB to 16GB | `qwen3:14b` | Higher quality, more VRAM pressure |
| 16GB to 24GB | `qwen3:30b` or `qwen3:32b` | Best quality in this range, can be slower |
| 24GB+ | `qwen3:30b` or `qwen3:32b` | Usually the practical ceiling for single GPU Ollama |

To force Qwen3 (general) in v1:

```env
MODEL_OVERRIDE=qwen3:8b
```

### Vast.ai "Terminal Connection Options" - how to read it

Vast typically shows two SSH options:

- **Direct ssh connect**: `ssh -p <PORT> <USER>@<INSTANCE_IP>`
- **Proxy ssh connect**: `ssh -p <PORT> <USER>@ssh1.vast.ai`

If you get `Connection refused` with the direct IP connection, use the proxy option.

When using proxy SSH, keep `VAST_HOST` set to the hostname `ssh1.vast.ai` (not the resolved IP), because the proxy backend can rotate.

Vast shows SSH connection details like:

```text
ssh -p <PORT> <USER>@<HOST>
```

Map that to `v1/.env`:

- **`<HOST>`** -> `VAST_HOST`
- **`<PORT>`** -> `VAST_PORT`
- **`<USER>`** -> `VAST_USER`

Example:

```text
Direct ssh connect:
ssh -p 52127 root@74.48.140.178

Proxy ssh connect:
ssh -p 34078 root@ssh1.vast.ai
```

becomes:

```env
VAST_HOST=ssh1.vast.ai
VAST_PORT=34078
VAST_USER=root
VAST_SSH_KEY_PATH=C:\Users\ventu\.ssh\id_ed25519
```

If Vast shows a port forward like:

```text
-L 8080:localhost:8080
```

that means "map remote port `8080` to local port `8080`". You can add additional forwards for v1 services as needed.

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
