import { executeRemote } from './ssh.js';

let cachedStatus = null;

export async function getAgentStatus() {
  try {
    const gatewayCheck = await executeRemote(
      'pgrep -f "openclaw gateway" > /dev/null && echo "running" || echo "stopped"',
      { quiet: true }
    );
    
    const running = gatewayCheck.trim() === 'running';
    
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
    
    return cachedStatus;
  } catch (error) {
    return {
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
  
  await executeRemote('pkill ollama || true', { quiet: true });
  await executeRemote('nohup ollama serve > /tmp/ollama.log 2>&1 &', { quiet: true });
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  await executeRemote(
    `pkill -9 -f "openclaw gateway" || true; ` +
    `nohup openclaw gateway run --bind loopback --port ${port} --force > /tmp/openclaw-gateway.log 2>&1 &`,
    { quiet: true }
  );
  
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  const check = await executeRemote(`pgrep -f "openclaw gateway"`, { quiet: true }).catch(() => '');
  
  if (!check.trim()) {
    throw new Error('Agent failed to start. Check logs with: v1 logs');
  }
  
  return { started: true };
}

export async function stopAgent() {
  await executeRemote('pkill -9 -f "openclaw gateway" || true', { quiet: true });
  await executeRemote('pkill ollama || true', { quiet: true });
  
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
