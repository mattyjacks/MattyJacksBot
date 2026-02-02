import { executeRemote, getConnectionStatus } from './ssh.js';

let cachedStatus = null;
let lastStatusCheck = 0;
const STATUS_CACHE_MS = 5000;

export async function getAgentStatus() {
  const { connected } = getConnectionStatus();
  
  if (!connected) {
    return cachedStatus || {
      running: false,
      model: null,
      vram: null,
      moltbookMode: process.env.MOLTBOOK_MODE || 'readonly',
      error: 'Not connected'
    };
  }
  
  if (cachedStatus && (Date.now() - lastStatusCheck) < STATUS_CACHE_MS) {
    return cachedStatus;
  }
  
  try {
    const gatewayCheck = await executeRemote(
      'pgrep -f "openclaw-gateway" >/dev/null 2>&1 || pgrep -f "openclaw gateway" >/dev/null 2>&1; echo $?',
      { quiet: true }
    );
    
    const running = gatewayCheck.trim() === '0';
    
    let model = null;
    try {
      model = (await executeRemote('cat ~/.openclaw/current_model 2>/dev/null', { quiet: true })).trim();
    } catch {}
    
    let vram = null;
    try {
      const vramResult = await executeRemote(
        "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1",
        { quiet: true }
      );
      vram = `${Math.floor(parseInt(vramResult.trim()) / 1024)}GB`;
    } catch {}
    
    const moltbookMode = process.env.MOLTBOOK_MODE || 'readonly';
    
    cachedStatus = {
      running,
      model,
      vram,
      moltbookMode,
      lastCheck: new Date().toISOString()
    };
    lastStatusCheck = Date.now();
    
    return cachedStatus;
  } catch (error) {
    return cachedStatus || {
      running: false,
      model: null,
      vram: null,
      moltbookMode: process.env.MOLTBOOK_MODE || 'readonly',
      error: error.message
    };
  }
}

export async function startAgent() {
  const port = process.env.OPENCLAW_GATEWAY_PORT || '18789';
  const tokenPath = '/root/.openclaw/gateway_token';
  const logPath = '/root/.openclaw/run/gateway.log';

  // If gateway already up on the port, treat Start as success (avoid lock timeout spam)
  const alreadyListening = await executeRemote(
    `ss -ltnp 2>/dev/null | grep :${port} || true`,
    { quiet: true }
  ).catch(() => '');
  if (alreadyListening.includes(`:${port}`)) {
    return { started: true, alreadyRunning: true };
  }

  // Ensure Ollama is running
  const ollamaRunning = await executeRemote('pgrep -x ollama >/dev/null 2>&1 && echo yes || echo no', { quiet: true }).catch(() => 'no');
  if (ollamaRunning.trim() !== 'yes') {
    await executeRemote('nohup ollama serve > /tmp/ollama.log 2>&1 &', { quiet: true }).catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  
  await executeRemote(`mkdir -p /root/.openclaw/run`, { quiet: true });
  await executeRemote('openclaw gateway stop 2>/dev/null || true', { quiet: true }).catch(() => null);
  await executeRemote(`pkill -9 -f "openclaw-gateway" || true`, { quiet: true }).catch(() => null);
  await executeRemote(`pkill -9 -f "openclaw gateway" || true`, { quiet: true }).catch(() => null);
  
  await executeRemote(
    `OPENCLAW_GATEWAY_TOKEN=$(cat ${tokenPath} 2>/dev/null || echo "") ` +
    `nohup openclaw gateway run --bind loopback --port ${port} --force --allow-unconfigured --auth token --verbose ` +
    `> ${logPath} 2>&1 &`,
    { quiet: true }
  );
  
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  const check = await executeRemote(`pgrep -f "openclaw-gateway" || pgrep -f "openclaw gateway" || true`, { quiet: true }).catch(() => '');
  
  if (!check.trim()) {
    const logs = await executeRemote(`tail -20 ${logPath} 2>/dev/null || echo "No logs"`, { quiet: true }).catch(() => 'Could not read logs');
    throw new Error(`Agent failed to start. Logs:\n${logs}`);
  }
  
  return { started: true };
}

export async function stopAgent() {
  await executeRemote('openclaw gateway stop 2>/dev/null || true', { quiet: true }).catch(() => null);
  await executeRemote('pkill -9 -f "openclaw-gateway" || true', { quiet: true }).catch(() => null);
  await executeRemote('pkill -9 -f "openclaw gateway" || true', { quiet: true }).catch(() => null);
  
  return { stopped: true };
}

export async function setMoltbookMode(mode) {
  const validModes = ['readonly', 'approval', 'autonomous'];
  
  if (!validModes.includes(mode)) {
    throw new Error(`Invalid mode. Must be one of: ${validModes.join(', ')}`);
  }
  
  const configPath = '~/.openclaw/moltbook_config.json';
  const config = {
    mode,
    updatedAt: new Date().toISOString()
  };
  
  await executeRemote(
    `echo '${JSON.stringify(config)}' > ${configPath}`,
    { quiet: true }
  );
  
  return { mode, updated: true };
}

export async function getMoltbookMode() {
  try {
    const result = await executeRemote(
      'cat ~/.openclaw/moltbook_config.json 2>/dev/null',
      { quiet: true }
    );
    const config = JSON.parse(result);
    return config.mode || 'readonly';
  } catch {
    return 'readonly';
  }
}

export async function getPendingPosts() {
  try {
    const result = await executeRemote(
      'cat ~/.openclaw/moltbook_pending.json 2>/dev/null || echo "[]"',
      { quiet: true }
    );
    return JSON.parse(result);
  } catch {
    return [];
  }
}

export async function approvePost(postId) {
  const pending = await getPendingPosts();
  const post = pending.find(p => p.id === postId);
  
  if (!post) {
    throw new Error(`Post ${postId} not found in pending queue`);
  }
  
  post.approved = true;
  post.approvedAt = new Date().toISOString();
  
  await executeRemote(
    `echo '${JSON.stringify(pending)}' > ~/.openclaw/moltbook_pending.json`,
    { quiet: true }
  );
  
  return { approved: true, post };
}

export async function rejectPost(postId) {
  const pending = await getPendingPosts();
  const filtered = pending.filter(p => p.id !== postId);
  
  await executeRemote(
    `echo '${JSON.stringify(filtered)}' > ~/.openclaw/moltbook_pending.json`,
    { quiet: true }
  );
  
  return { rejected: true, postId };
}
