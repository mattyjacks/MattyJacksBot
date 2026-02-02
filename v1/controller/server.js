import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import dotenv from 'dotenv';

import { connect, getConnectionStatus, executeRemote } from './ssh.js';
import { runSync, getSyncStatus } from './sync.js';
import { getAgentStatus, startAgent, stopAgent, setMoltbookMode, getPendingPosts, approvePost, rejectPost } from './agent.js';
import { startTelegramBot } from './telegram.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

const UI_DIST = join(__dirname, '..', 'ui', 'dist');

function getOrCreateAuthToken() {
  const envPath = join(__dirname, '..', '.env');
  let token = process.env.UI_AUTH_TOKEN;
  
  if (!token) {
    token = randomBytes(32).toString('hex');
    
    if (existsSync(envPath)) {
      let envContent = readFileSync(envPath, 'utf-8');
      if (envContent.includes('UI_AUTH_TOKEN=')) {
        envContent = envContent.replace(/UI_AUTH_TOKEN=.*/, `UI_AUTH_TOKEN=${token}`);
      } else {
        envContent += `\nUI_AUTH_TOKEN=${token}`;
      }
      writeFileSync(envPath, envContent);
    }
    
    process.env.UI_AUTH_TOKEN = token;
  }
  
  return token;
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const expectedToken = getOrCreateAuthToken();
  
  if (req.path === '/api/auth/token' || req.path.startsWith('/assets') || req.path === '/') {
    return next();
  }
  
  if (!token || token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
}

app.use(authMiddleware);

app.get('/api/auth/token', (req, res) => {
  const token = getOrCreateAuthToken();
  console.log(`\n🔐 Auth token: ${token}\n`);
  res.json({ message: 'Token logged to console' });
});

app.get('/api/status', async (req, res) => {
  try {
    const [connection, sync, agent] = await Promise.all([
      getConnectionStatus(),
      getSyncStatus(),
      getAgentStatus()
    ]);
    
    res.json({
      connection,
      sync,
      agent,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/connect', async (req, res) => {
  try {
    const { force = false } = req.body;
    const result = await connect({ force, verbose: true });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const { dryRun = false } = req.body;
    const result = await runSync({ dryRun, verbose: true });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/agent/start', async (req, res) => {
  try {
    const result = await startAgent();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/agent/stop', async (req, res) => {
  try {
    const result = await stopAgent();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/moltbook/mode', async (req, res) => {
  try {
    const status = await getAgentStatus();
    res.json({ mode: status.moltbookMode });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/moltbook/mode', async (req, res) => {
  try {
    const { mode } = req.body;
    const result = await setMoltbookMode(mode);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/moltbook/pending', async (req, res) => {
  try {
    const pending = await getPendingPosts();
    res.json(pending);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/moltbook/approve/:postId', async (req, res) => {
  try {
    const result = await approvePost(req.params.postId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/moltbook/reject/:postId', async (req, res) => {
  try {
    const result = await rejectPost(req.params.postId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    const lines = parseInt(req.query.lines || '100');
    const logs = await executeRemote(
      `tail -n ${lines} /tmp/openclaw-gateway.log 2>/dev/null || echo "No logs"`,
      { quiet: true }
    );
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    syncRoot: process.env.SYNC_ROOT,
    modelFamily: process.env.MODEL_FAMILY || 'qwen3-coder',
    moltbookMode: process.env.MOLTBOOK_MODE || 'readonly',
    gatewayPort: process.env.OPENCLAW_GATEWAY_PORT || '18789',
    syncConflictPolicy: process.env.SYNC_CONFLICT_POLICY || 'newest',
    sandboxNonMain: process.env.SANDBOX_NON_MAIN === 'true',
    requirePostApproval: process.env.REQUIRE_POST_APPROVAL !== 'false'
  });
});

if (existsSync(UI_DIST)) {
  app.use(express.static(UI_DIST));
  app.get('*', (req, res) => {
    res.sendFile(join(UI_DIST, 'index.html'));
  });
}

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'subscribe_logs') {
        // Stream logs via WebSocket
      }
    } catch (error) {
      ws.send(JSON.stringify({ error: error.message }));
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

export function startServer() {
  const port = parseInt(process.env.UI_PORT || '3333');
  
  server.listen(port, () => {
    const token = getOrCreateAuthToken();
    console.log(`
🦞 Moltbook + OpenClaw v1 Control Server

   Local:   http://localhost:${port}
   
   Auth Token: ${token}
   
   Add this token to the UI or use it in API requests.
`);
  });
  
  if (process.env.TELEGRAM_BOT_TOKEN) {
    startTelegramBot();
  }
  
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
