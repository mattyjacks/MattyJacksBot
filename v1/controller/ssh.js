import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import dns from 'dns';
import { getBootstrapScript } from './bootstrap.js';

let sshConnection = null;
let connectionConfig = null;

function getConfig() {
  return {
    host: process.env.VAST_HOST,
    port: parseInt(process.env.VAST_PORT || '22'),
    username: process.env.VAST_USER || 'root',
    privateKey: process.env.VAST_SSH_KEY_PATH 
      ? readFileSync(process.env.VAST_SSH_KEY_PATH.replace('~', homedir()))
      : undefined,
    password: process.env.VAST_PASSWORD,
    readyTimeout: parseInt(process.env.VAST_SSH_READY_TIMEOUT_MS || '30000'),
    keepaliveInterval: parseInt(process.env.VAST_SSH_KEEPALIVE_INTERVAL_MS || '10000'),
    keepaliveCountMax: parseInt(process.env.VAST_SSH_KEEPALIVE_COUNT_MAX || '3')
  };
}

function isRetryableConnectError(err) {
  const codes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);
  if (!err) return false;
  if (typeof err.code === 'string' && codes.has(err.code)) return true;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('timed out');
}

async function resolveHostAddresses(host) {
  try {
    const results = await dns.promises.lookup(host, { all: true });
    const addresses = results.map(r => r.address).filter(Boolean);
    if (addresses.length > 0) return addresses;
  } catch {
    // ignore and fall back to host as-is
  }
  return [host];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatProgressBar(percent, width = 28) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  const empty = Math.max(0, width - filled);
  return `[${'='.repeat(filled)}${' '.repeat(empty)}]`;
}

function parseOllamaPullProgress(text) {
  const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const pm = line.match(/(\d{1,3})%/);
    if (!pm) continue;

    const percent = parseInt(pm[1], 10);
    const bytes = (line.match(/([\d.]+\s*[KMG]B)\s*\/\s*([\d.]+\s*[KMG]B)/i) || []).slice(1);
    const transferred = bytes[0] || '';
    const total = bytes[1] || '';
    const sm = line.match(/([\d.]+\s*[KMG]B\/s)/i);
    const speed = sm ? sm[1] : '';
    const em = line.match(/\s(\d+[smhd]\d*[smhd]?)\s*$/i);
    const eta = em ? em[1] : '';

    return { percent, transferred, total, speed, eta, raw: line };
  }
  return null;
}

function renderPullProgress(model, progress) {
  if (!progress) {
    process.stdout.write(`\r  Pulling ${model} ...`);
    return;
  }
  const bar = formatProgressBar(progress.percent);
  const parts = [
    `Pulling ${model}`,
    bar,
    `${progress.percent}%`
  ];
  if (progress.transferred && progress.total) {
    parts.push(`${progress.transferred}/${progress.total}`);
  }
  if (progress.speed) {
    parts.push(progress.speed);
  }
  if (progress.eta) {
    parts.push(progress.eta);
  }
  const line = `  ${parts.join('  ')}`;
  process.stdout.write(`\r${line}`);
}

async function connectOnce(config, options = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      sshConnection = conn;
      resolve(conn);
    });

    conn.on('error', (err) => {
      reject(err);
    });

    conn.connect(config);
  });
}

async function connectWithRetry(baseConfig, options = {}) {
  const maxAttempts = parseInt(process.env.VAST_SSH_CONNECT_RETRIES || '5');
  const addresses = await resolveHostAddresses(baseConfig.host);

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    for (const hostAddress of addresses) {
      const config = { ...baseConfig, host: hostAddress };
      try {
        const conn = await connectOnce(config, options);
        return { conn, connectedHost: hostAddress };
      } catch (err) {
        lastErr = err;
        if (!isRetryableConnectError(err)) {
          throw err;
        }
      }
    }

    const backoffMs = Math.min(2000 * attempt, 10000);
    await sleep(backoffMs);
  }

  throw lastErr || new Error('SSH connection failed');
}

export async function connect(options = {}) {
  const config = getConfig();
  
  if (!config.host) {
    throw new Error('VAST_HOST not configured in .env');
  }
  
  if (!config.privateKey && !config.password) {
    throw new Error('Either VAST_SSH_KEY_PATH or VAST_PASSWORD must be set in .env');
  }
  
  connectionConfig = config;

  try {
    const { conn, connectedHost } = await connectWithRetry(config, options);
    console.log('  SSH connection established');

    try {
      await bootstrap(conn, options);
      return { connected: true, host: connectedHost };
    } catch (error) {
      throw error;
    }
  } catch (err) {
    throw new Error(`SSH connection failed: ${err.message}`);
  }
}

async function bootstrap(conn, options = {}) {
  const { force = false, verbose = false } = options;
  
  const checkInstalled = await executeRemote('which openclaw && which ollama', { quiet: true }).catch(() => null);
  
  if (checkInstalled && !force) {
    console.log('  OpenClaw and Ollama already installed');
    
    const vram = await detectVRAM();
    console.log(`  Detected VRAM: ${vram}GB`);
    
    await ensureModelPulled(vram);
    await ensureGatewayRunning();
    
    return;
  }
  
  console.log('  Running bootstrap script...');
  
  const script = getBootstrapScript();
  
  await executeRemote(script, { verbose });
  
  const vram = await detectVRAM();
  console.log(`  Detected VRAM: ${vram}GB`);
  
  await pullModelForVRAM(vram);
  
  await startGateway();
  
  await setupWorkspace();
}

async function detectVRAM() {
  try {
    const result = await executeRemote(
      "nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1",
      { quiet: true }
    );
    const vramMB = parseInt(result.trim());
    return Math.floor(vramMB / 1024);
  } catch {
    console.log('  Warning: Could not detect VRAM, defaulting to 12GB');
    return 12;
  }
}

function selectModelForVRAM(vramGB) {
  const family = process.env.MODEL_FAMILY || 'qwen3-coder';
  const override = process.env.MODEL_OVERRIDE;
  
  if (override) {
    return override;
  }
  
  const lowThreshold = parseInt(process.env.VRAM_THRESHOLD_LOW || '10');
  const midThreshold = parseInt(process.env.VRAM_THRESHOLD_MID || '12');
  const highThreshold = parseInt(process.env.VRAM_THRESHOLD_HIGH || '16');
  
  const isCoder = family.toLowerCase().includes('coder');

  if (isCoder) {
    if (vramGB < lowThreshold) {
      return `${family}:7b`;
    } else if (vramGB < highThreshold) {
      return `${family}:14b`;
    } else {
      return `${family}:30b`;
    }
  }

  if (vramGB < lowThreshold) {
    return `${family}:4b`;
  } else if (vramGB < midThreshold) {
    return `${family}:8b`;
  } else if (vramGB < highThreshold) {
    return `${family}:14b`;
  } else {
    return `${family}:30b`;
  }
}

function buildModelCandidates(primaryModel) {
  const candidates = [];

  const add = (m) => {
    if (!m) return;
    if (!candidates.includes(m)) candidates.push(m);
  };

  add(primaryModel);

  const [name, tag] = primaryModel.split(':');
  add(name);
  add(`${name}:latest`);

  if (tag) {
    const fallbackName = name === 'qwen3-coder' ? 'qwen2.5-coder' : null;
    if (fallbackName) {
      add(`${fallbackName}:${tag}`);
      add(fallbackName);
      add(`${fallbackName}:latest`);
    }
  }

  return candidates;
}

function normalizeModelNameForOllamaCheck(model) {
  if (!model) return '';
  return model.includes(':') ? model : `${model}:latest`;
}

async function startOllamaPullBackground(model) {
  const safeModel = model.replace(/"/g, '');
  const cmd = `nohup bash -lc "ollama pull ${safeModel} > /tmp/ollama-pull.log 2>&1" >/dev/null 2>&1 & echo started`;
  await executeRemote(cmd, { quiet: true });
}

async function isModelPresent(model) {
  const normalized = normalizeModelNameForOllamaCheck(model);
  const nameOnly = normalized.split(':')[0];
  const out = await executeRemote('ollama list 2>/dev/null || true', { quiet: true });
  const hay = out.toLowerCase();
  return hay.includes(normalized.toLowerCase()) || hay.includes(`${nameOnly.toLowerCase()}:latest`);
}

async function waitForModel(model, timeoutMs) {
  const start = Date.now();
  let lastProgressKey = '';
  let lastPresenceCheck = 0;
  while (Date.now() - start < timeoutMs) {
    const tail = await executeRemote('tail -n 20 /tmp/ollama-pull.log 2>/dev/null || true', { quiet: true });
    const progress = parseOllamaPullProgress(tail);
    const key = progress ? `${progress.percent}-${progress.transferred}-${progress.total}-${progress.speed}-${progress.eta}` : 'none';
    if (key !== lastProgressKey) {
      renderPullProgress(model, progress);
      lastProgressKey = key;
    }

    const now = Date.now();
    if (now - lastPresenceCheck > 20000) {
      const present = await isModelPresent(model);
      if (present) {
        process.stdout.write('\n');
        return;
      }
      lastPresenceCheck = now;
    }

    await sleep(2000);
  }
  const tail = await executeRemote('tail -n 50 /tmp/ollama-pull.log 2>/dev/null || true', { quiet: true });
  throw new Error(`Timed out waiting for model pull: ${model}. Tail of /tmp/ollama-pull.log:\n${tail}`);
}

async function pullModelForVRAM(vramGB) {
  const primaryModel = selectModelForVRAM(vramGB);
  const candidates = buildModelCandidates(primaryModel);
  console.log(`  Pulling model: ${primaryModel}`);

  let lastError = null;
  for (const model of candidates) {
    try {
      if (model !== primaryModel) {
        console.log(`  Trying fallback model: ${model}`);
      }
      const timeoutMs = parseInt(process.env.OLLAMA_PULL_TIMEOUT_MS || '21600000');
      await startOllamaPullBackground(model);
      await waitForModel(model, timeoutMs);
      await executeRemote(`echo "${model}" > ~/.openclaw/current_model`, { quiet: true });
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Model pull failed for all candidates. ` +
    `Primary was "${primaryModel}". ` +
    `Set MODEL_OVERRIDE in .env to a valid Ollama model name (for example, one that works with: ollama pull <model>). ` +
    `Last error: ${lastError?.message || 'unknown error'}`
  );
}

async function ensureModelPulled(vramGB) {
  const model = selectModelForVRAM(vramGB);
  
  const currentModel = await executeRemote('cat ~/.openclaw/current_model 2>/dev/null || echo ""', { quiet: true });
  
  if (currentModel.trim() !== model) {
    console.log(`  Model mismatch, pulling: ${model} (set MODEL_OVERRIDE to force a specific tag)`);
    await pullModelForVRAM(vramGB);
  } else {
    console.log(`  Model ready: ${model}`);
  }
}

async function ensureGatewayRunning() {
  const running = await executeRemote('pgrep -f "openclaw gateway"', { quiet: true }).catch(() => '');
  
  if (!running.trim()) {
    console.log('  Starting OpenClaw gateway...');
    await startGateway();
  } else {
    console.log('  Gateway already running');
  }
}

function modelFamilyName() {
  const family = (process.env.MODEL_FAMILY || 'qwen3').trim();
  return family.split(':')[0];
}

async function ensureOpenclawConfig() {
  const workspace = process.env.OPENCLAW_WORKSPACE || '~/moltbook/v1/agent_runtime/workspace';
  const family = modelFamilyName();

  const hasLegacy = await executeRemote(
    'test -f ~/.openclaw/openclaw.json && grep -q ' +
      '"agent"' +
      ' ~/.openclaw/openclaw.json && echo yes || echo no',
    { quiet: true }
  ).catch(() => 'no');

  if (hasLegacy.trim() !== 'yes') return;

  await executeRemote(
    `mkdir -p ~/.openclaw; ` +
      `cp -f ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%s) || true; ` +
      `cat > ~/.openclaw/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "workspace": "${workspace}",
      "sandbox": {
        "mode": "non-main"
      },
      "model": {
        "primary": "ollama/${family}",
        "fallbacks": []
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "loopback"
  }
}
EOF`,
    { quiet: true }
  );
}

async function ensureGatewayToken() {
  const existing = (process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
  if (existing) return existing;

  const remote = await executeRemote(
    'mkdir -p ~/.openclaw; ' +
      'TOKEN_FILE=~/.openclaw/gateway_token; ' +
      'if [ -f "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then cat "$TOKEN_FILE"; ' +
      'else python3 - << "PY"\nimport secrets\nprint(secrets.token_hex(32))\nPY ' +
      '> "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"; cat "$TOKEN_FILE"; fi',
    { quiet: true }
  );

  return remote.trim();
}

async function startGateway() {
  const port = process.env.OPENCLAW_GATEWAY_PORT || '18789';
  const runDir = '~/.openclaw/run';
  const logPath = `${runDir}/gateway.log`;
  const pidPath = `${runDir}/gateway.pid`;

  const openclawPath = await executeRemote('command -v openclaw 2>/dev/null || true', { quiet: true }).catch(() => '');
  if (!openclawPath.trim()) {
    throw new Error('OpenClaw not found on remote (command -v openclaw returned empty). Re-run connect with --force or install openclaw on the instance.');
  }

  await executeRemote(
    'command -v ss >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq iproute2); ' +
    'command -v netstat >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq net-tools)',
    { quiet: true }
  ).catch(() => null);

  await ensureOpenclawConfig();
  const token = await ensureGatewayToken();
  
  await executeRemote(
    `bash -lc '` +
      `mkdir -p ${runDir}; ` +
      `pkill -9 -f "openclaw gateway" || true; ` +
      `rm -f ${logPath} ${pidPath}; ` +
      `touch ${logPath} ${pidPath}; ` +
      `chmod 600 ${logPath} ${pidPath} || true; ` +
      `export OPENCLAW_GATEWAY_TOKEN="${token}"; ` +
      `nohup openclaw gateway run --bind loopback --port ${port} --force --allow-unconfigured --auth token --verbose ` +
      `> ${logPath} 2>&1 < /dev/null & ` +
      `echo $! > ${pidPath}; ` +
      `sleep 1; ` +
      `cat ${pidPath} 2>/dev/null || true; ` +
      `ps -p $(cat ${pidPath} 2>/dev/null) -o pid= -o comm= 2>/dev/null || true; ` +
      `ls -la ${runDir} || true'`,
    { quiet: true }
  );

  const startupTimeoutMs = parseInt(process.env.OPENCLAW_GATEWAY_START_TIMEOUT_MS || '30000');
  const start = Date.now();
  let lastCheck = '';
  let pid = '';

  pid = await executeRemote(`cat ${pidPath} 2>/dev/null || true`, { quiet: true }).catch(() => '');

  while (Date.now() - start < startupTimeoutMs) {
    const ssCheck = await executeRemote(`ss -ltnp 2>/dev/null | grep :${port} || true`, { quiet: true }).catch(() => '');
    const nsCheck = await executeRemote(`netstat -lntp 2>/dev/null | grep :${port} || true`, { quiet: true }).catch(() => '');
    const check = `${ssCheck}\n${nsCheck}`.trim();
    lastCheck = check;

    if (check.includes(`:${port}`) || check.includes(` ${port} `) || check.includes(port)) {
      console.log(`  Gateway running on port ${port}`);
      return;
    }

    if (pid.trim()) {
      const pidAliveCheck = await executeRemote(`ps -p ${pid.trim()} -o pid= -o comm= 2>/dev/null || true`, { quiet: true }).catch(() => '');
      if (!pidAliveCheck.trim()) {
        break;
      }
    } else {
      const running = await executeRemote('pgrep -f "openclaw gateway" || true', { quiet: true }).catch(() => '');
      if (!running.trim()) {
        break;
      }
    }

    await sleep(1000);
  }

  const pidAlive = pid.trim()
    ? await executeRemote(`ps -p ${pid.trim()} -o pid= -o comm= 2>/dev/null || true`, { quiet: true }).catch(() => '')
    : '';

  const list = await executeRemote(`ls -la ${runDir} 2>/dev/null || true`, { quiet: true }).catch(() => '');
  const logStat = await executeRemote(`ls -la ${logPath} 2>/dev/null || true`, { quiet: true }).catch(() => '');
  const tail = await executeRemote(`tail -n 200 ${logPath} 2>/dev/null || true`, { quiet: true }).catch(() => '');
  const version = await executeRemote('openclaw --version 2>&1 || true', { quiet: true }).catch(() => '');
  const gatewayHelp = await executeRemote('openclaw gateway --help 2>&1 || true', { quiet: true }).catch(() => '');

  throw new Error(
    `Gateway failed to start. ` +
    `PID: ${pid.trim() || 'unknown'}\n` +
    `PID alive: ${pidAlive.trim() || 'no'}\n\n` +
    `Port check output:\n${lastCheck}\n\n` +
    `Files:\n${list}\n\n` +
    `Log stat:\n${logStat}\n\n` +
    `Tail of gateway log:\n${tail}`
    + `\n\nOpenClaw version:\n${version}`
    + `\n\nOpenClaw gateway help:\n${gatewayHelp}`
  );
}

async function setupWorkspace() {
  const workspace = process.env.OPENCLAW_WORKSPACE || '~/moltbook/v1/agent_runtime/workspace';
  
  await executeRemote(`
    mkdir -p ${workspace}/skills
    mkdir -p ~/moltbook/v1/sync/public
    mkdir -p ~/moltbook/v1/sync/private
    mkdir -p ~/moltbook/v1/sync/artifacts
    mkdir -p ~/moltbook/v1/sync/state
  `, { quiet: true });
  
  console.log('  Workspace directories created');
}

export async function executeRemote(command, options = {}) {
  const { quiet = false, verbose = false } = options;
  
  if (!sshConnection) {
    const config = getConfig();
    await connect({ force: false, verbose: false });
  }
  
  const runOnce = () => new Promise((resolve, reject) => {
    sshConnection.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('data', (data) => {
        stdout += data.toString();
        if (verbose && !quiet) {
          process.stdout.write(data);
        }
      });

      stream.stderr.on('data', (data) => {
        stderr += data.toString();
        if (verbose && !quiet) {
          process.stderr.write(data);
        }
      });

      stream.on('close', (code) => {
        if (code !== 0 && !quiet) {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });
    });
  });

  try {
    return await runOnce();
  } catch (err) {
    if ((err?.message || '').toLowerCase().includes('not connected')) {
      disconnect();
      await connect({ force: false, verbose: false });
      return await runOnce();
    }
    throw err;
  }
}

export async function getConnectionStatus() {
  const config = getConfig();
  
  if (!config.host) {
    return { connected: false, host: null };
  }
  
  if (sshConnection) {
    return { connected: true, host: config.host };
  }
  
  try {
    await connect({ force: false, verbose: false });
    return { connected: true, host: config.host };
  } catch {
    return { connected: false, host: config.host };
  }
}

export function disconnect() {
  if (sshConnection) {
    sshConnection.end();
    sshConnection = null;
  }
}
