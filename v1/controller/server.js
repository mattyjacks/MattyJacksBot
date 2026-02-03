import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';

import { connect, getConnectionStatus, executeRemote } from './ssh.js';
import { runSync, getSyncStatus } from './sync.js';
import { getAgentStatus, startAgent, stopAgent, setMoltbookMode, getPendingPosts, approvePost, rejectPost } from './agent.js';
import { getBrainStatus, indexBrain, queryBrain, listBrainProposals, createBrainProposal, applyBrainProposal } from './brain.js';
import { startTelegramBot } from './telegram.js';

const execFileAsync = promisify(execFile);

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
      brain: getBrainStatus(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sync/open-folder', async (req, res) => {
  try {
    const { folder } = req.body || {};
    const allowed = new Set(['root', 'public', 'private', 'artifacts', 'brain']);
    if (!allowed.has(folder)) {
      return res.status(400).json({ error: 'Invalid folder' });
    }

    const syncStatus = await getSyncStatus();
    const root = syncStatus.syncRoot;
    const targetPath = folder === 'root'
      ? root
      : folder === 'brain'
        ? join(root, 'artifacts', 'brain')
        : join(root, folder);

    if (process.platform === 'win32') {
      await execFileAsync('explorer.exe', [targetPath]);
    } else if (process.platform === 'darwin') {
      await execFileAsync('open', [targetPath]);
    } else {
      await execFileAsync('xdg-open', [targetPath]);
    }

    res.json({ opened: true, path: targetPath });
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
      `tail -n ${lines} /root/.openclaw/run/gateway.log 2>/dev/null || echo "No logs"`,
      { quiet: true }
    );
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/openclaw/webui', async (req, res) => {
  try {
    const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || '18789';
    const tunnelCmd = `ssh -N -L ${gatewayPort}:127.0.0.1:${gatewayPort} -p ${process.env.VAST_PORT} ${process.env.VAST_USER}@${process.env.VAST_HOST} -i ${process.env.VAST_SSH_KEY_PATH}`;
    
    const { connected } = getConnectionStatus();
    
    if (!connected) {
      return res.json({ 
        success: false,
        port: gatewayPort,
        message: 'Not connected to Vast instance. Click Connect first.',
        tunnelCommand: tunnelCmd,
        webUrl: `http://localhost:${gatewayPort}/`
      });
    }
    
    let isRunning = false;
    let token = null;
    try {
      const check = await executeRemote(`ss -ltnp | grep :${gatewayPort} || true`, { quiet: true });
      isRunning = check.includes(`:${gatewayPort}`);
      token = (await executeRemote(`cat /root/.openclaw/gateway_token 2>/dev/null || true`, { quiet: true })).trim();
    } catch {
      // Connection may have dropped, return safe fallback
    }
    
    const tokenizedUrl = token ? `http://localhost:${gatewayPort}/?token=${token}` : `http://localhost:${gatewayPort}/`;
    
    res.json({ 
      success: isRunning,
      port: gatewayPort,
      message: isRunning 
        ? `Gateway running! Set up tunnel, then open the tokenized URL below.`
        : 'Gateway may not be running. Try clicking Connect.',
      tunnelCommand: tunnelCmd,
      webUrl: tokenizedUrl,
      token: token || null
    });
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

app.get('/api/brain/status', async (req, res) => {
  try {
    res.json(getBrainStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/brain/index', async (req, res) => {
  try {
    const { include } = req.body || {};
    res.json(indexBrain({ include }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/brain/query', async (req, res) => {
  try {
    const q = (req.query.q || '').toString();
    const limit = parseInt((req.query.limit || '10').toString());
    res.json(queryBrain(q, { limit }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/brain/proposals', async (req, res) => {
  try {
    res.json(listBrainProposals());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/brain/propose', async (req, res) => {
  try {
    const { subdir, path, instruction, contextQuery, allowOverwrite, autoIndex } = req.body || {};
    const result = await createBrainProposal({
      subdir,
      path,
      instruction,
      contextQuery,
      allowOverwrite,
      autoIndex
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/brain/apply', async (req, res) => {
  try {
    const { proposalId, allowOverwrite } = req.body || {};
    res.json(applyBrainProposal({ proposalId, allowOverwrite }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
