# v1 Architecture

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Your Windows PC                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │   Chrome GUI    │  │   Telegram Bot  │  │      CLI (v1)       │  │
│  │  localhost:3333 │  │                 │  │                     │  │
│  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘  │
│           │                    │                      │              │
│           └────────────────────┼──────────────────────┘              │
│                                │                                     │
│                    ┌───────────▼───────────┐                        │
│                    │     Controller        │                        │
│                    │  (Express + SSH2)     │                        │
│                    └───────────┬───────────┘                        │
│                                │                                     │
│  ┌─────────────────────────────┼─────────────────────────────────┐  │
│  │           Sync Folders      │                                  │  │
│  │  ┌──────────┐ ┌──────────┐ │ ┌──────────┐ ┌──────────┐       │  │
│  │  │  public/ │ │ private/ │ │ │artifacts/│ │  state/  │       │  │
│  │  └──────────┘ └──────────┘ │ └──────────┘ └──────────┘       │  │
│  └─────────────────────────────┼─────────────────────────────────┘  │
└────────────────────────────────┼────────────────────────────────────┘
                                 │
                         SSH + Bidirectional Sync
                                 │
┌────────────────────────────────┼────────────────────────────────────┐
│                         Vast.ai Instance                             │
│                                │                                     │
│                    ┌───────────▼───────────┐                        │
│                    │   OpenClaw Gateway    │                        │
│                    │    (port 18789)       │                        │
│                    └───────────┬───────────┘                        │
│                                │                                     │
│           ┌────────────────────┼────────────────────┐               │
│           │                    │                    │               │
│  ┌────────▼────────┐  ┌────────▼────────┐  ┌───────▼───────┐       │
│  │     Ollama      │  │    Workspace    │  │ Moltbook Skill│       │
│  │  (Qwen3-Coder)  │  │                 │  │               │       │
│  └─────────────────┘  └─────────────────┘  └───────────────┘       │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Synced Folders                            │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │    │
│  │  │  public/ │ │ private/ │ │artifacts/│ │  state/  │        │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘        │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

## Components

### Controller (PC)

- **server.js** - Express server hosting the API and static UI
- **cli.js** - Command-line interface using Commander
- **ssh.js** - SSH connection and remote execution
- **sync.js** - Bidirectional file sync logic
- **agent.js** - Agent control (start/stop/status)
- **telegram.js** - Telegram bot for remote control
- **bootstrap.js** - Vast.ai setup scripts

### UI (PC)

- **React + Vite** - Modern build tooling
- **Tailwind CSS** - Utility-first styling
- **Lucide React** - Icon library

### Remote (Vast.ai)

- **Ollama** - Local LLM inference server
- **OpenClaw** - Agent orchestration framework
- **Moltbook Skill** - Social network integration

## Data Flow

### Sync Flow

```
1. User places file in local public/
2. User runs sync (CLI or GUI)
3. Controller compares local vs remote file lists
4. Detects new/modified files
5. Uploads via SSH (base64 encoded)
6. Downloads artifacts from remote
7. Resolves conflicts (newest wins + backup)
8. Updates sync state
```

### Agent Flow

```
1. OpenClaw gateway receives prompt
2. Gateway loads context from workspace (synced files)
3. Gateway calls Ollama for inference
4. Agent executes tools/skills
5. Moltbook skill queues post (if in approval mode)
6. Post waits for human approval
7. Approved posts are sent to Moltbook
8. Artifacts/logs written to artifacts/
9. Next sync pulls artifacts to PC
```

### Security Flow

```
1. GUI requires auth token (generated on first run)
2. Telegram bot checks user ID allowlist
3. Moltbook defaults to readonly
4. Posts require explicit approval
5. Non-main sessions run sandboxed
6. Private files never exposed to Moltbook
```

## Model Selection

VRAM-based auto-selection:

| VRAM | Model |
|------|-------|
| < 10GB | qwen3-coder:7b-q4_K_M |
| 10-12GB | qwen3-coder:7b-q5_K_M |
| 12-16GB | qwen3-coder:14b-q4_K_M |
| > 16GB | qwen3-coder:14b-q5_K_M |

Override via `MODEL_OVERRIDE` in `.env`.

## File Purposes

| Folder | Description | Synced | Posted |
|--------|-------------|--------|--------|
| public/ | Shareable content | Yes | Allowed |
| private/ | Sensitive content | Yes | Never |
| artifacts/ | Agent outputs | Yes (download only) | No |
| state/ | Sync metadata | No | No |
