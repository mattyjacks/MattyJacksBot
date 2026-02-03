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
    await ensureOpenclawConfig();
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
  const running = await executeRemote(
    'pgrep -f "openclaw-gateway" >/dev/null 2>&1 || pgrep -f "openclaw gateway" >/dev/null 2>&1; echo $?',
    { quiet: true }
  ).catch(() => '1');
  
  if (running.trim() !== '0') {
    console.log('  Starting OpenClaw gateway...');
    await startGateway();
  } else {
    const port = process.env.OPENCLAW_GATEWAY_PORT || '18789';
    const portListening = await executeRemote(
      `ss -ltnp 2>/dev/null | grep :${port} || true`,
      { quiet: true }
    ).catch(() => '');
    if (!portListening.trim()) {
      console.log(`  Gateway process found but port ${port} is not listening, restarting...`);
      await startGateway();
      return;
    }

    const logPath = '/root/.openclaw/run/gateway.log';
    const tail = await executeRemote(`tail -n 80 ${logPath} 2>/dev/null || true`, { quiet: true }).catch(() => '');
    if (tail.includes('Invalid config at') || tail.includes('Config invalid')) {
      console.log('  Gateway running but config is invalid, restarting...');
      await startGateway();
    } else if (tail.includes('No API key found for provider "ollama"')) {
      console.log('  Gateway running but Ollama auth is missing, restarting...');
      await startGateway();
    } else if (tail.includes('Unknown model:')) {
      console.log('  Gateway running but reports Unknown model, restarting...');
      await startGateway();
    } else {
      console.log('  Gateway already running');
    }
  }
}

function getSelectedModel() {
  return process.env.MODEL_OVERRIDE || process.env.SELECTED_MODEL || 'qwen3:8b';
}

async function ensureOpenclawConfig() {
  const workspace = process.env.OPENCLAW_WORKSPACE || '~/mattyjacksbot/v1/agent_runtime/workspace';
  let model = getSelectedModel();
  if (!process.env.MODEL_OVERRIDE && !process.env.SELECTED_MODEL) {
    const currentModel = await executeRemote('cat ~/.openclaw/current_model 2>/dev/null || echo ""', { quiet: true }).catch(() => '');
    if (currentModel.trim()) model = currentModel.trim();
  }

  await executeRemote(
    `mkdir -p /root/.openclaw; ` +
      `cat > /tmp/openclaw_fix_config.py << 'PYEOF'
import json
import os

p = '/root/.openclaw/openclaw.json'

data = {}
if os.path.exists(p):
    try:
        with open(p, 'r') as f:
            raw = f.read().strip()
        if raw:
            data = json.loads(raw)
    except Exception:
        data = {}

orig = json.dumps(data, sort_keys=True)

agents = data.setdefault('agents', {})
defaults = agents.setdefault('defaults', {})

defaults['workspace'] = ${JSON.stringify(workspace)}

sandbox = defaults.setdefault('sandbox', {})
sandbox['mode'] = 'non-main'

model_cfg = defaults.setdefault('model', {})
model_cfg['primary'] = 'ollama/${model}'
fallbacks = model_cfg.get('fallbacks')
if not isinstance(fallbacks, list):
    model_cfg['fallbacks'] = []

gateway = data.setdefault('gateway', {})
gateway['mode'] = 'local'
gateway['bind'] = 'loopback'

models = data.setdefault('models', {})
providers = models.setdefault('providers', {})
ollama = providers.setdefault('ollama', {})
ollama['baseUrl'] = 'http://127.0.0.1:11434/v1'
ollama['apiKey'] = ollama.get('apiKey') or 'local'
ollama['api'] = ollama.get('api') or 'openai-completions'

need_models_reset = False
existing_models = ollama.get('models')
if not isinstance(existing_models, list) or len(existing_models) == 0:
    need_models_reset = True
else:
    for m in existing_models:
        if not isinstance(m, dict):
            need_models_reset = True
            break
        if not isinstance(m.get('id'), str) or not m.get('id'):
            need_models_reset = True
            break
        if not isinstance(m.get('name'), str) or not m.get('name'):
            need_models_reset = True
            break

if need_models_reset:
    ollama['models'] = [
        {
            'id': '${model}',
            'name': '${model}',
            'api': 'openai-completions',
            'reasoning': False,
            'input': ['text'],
            'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}
        }
    ]

new = json.dumps(data, sort_keys=True)
if new != orig:
    with open(p, 'w') as f:
        json.dump(data, f, indent=2)
PYEOF
python3 /tmp/openclaw_fix_config.py`,
    { quiet: true }
  ).catch(() => null);

  const modelStatus = await executeRemote('openclaw models status --plain 2>/dev/null || true', { quiet: true }).catch(() => '');
  const wanted = `ollama/${model}`;
  const alreadyDefault = modelStatus.includes(wanted) && (modelStatus.includes('Default') || modelStatus.includes('Default model'));
  if (!alreadyDefault) {
    await executeRemote(`openclaw models set ${wanted} 2>/dev/null || true`, { quiet: true }).catch(() => null);
  }

  await executeRemote(
    `mkdir -p /root/.openclaw/agents/main/agent; ` +
      `cat > /tmp/openclaw_fix_auth.py << 'PYEOF'
import json
import os

p = '/root/.openclaw/agents/main/agent/auth-profiles.json'

data = {}
if os.path.exists(p):
    try:
        with open(p, 'r') as f:
            raw = f.read().strip()
        if raw:
            data = json.loads(raw)
    except Exception:
        data = {}

data['ollama:local'] = {'type': 'token', 'provider': 'ollama', 'token': 'not-required'}
lg = data.get('lastGood')
if not isinstance(lg, dict):
    lg = {}
lg['ollama'] = 'ollama:local'
data['lastGood'] = lg

with open(p, 'w') as f:
    json.dump(data, f, indent=2)
PYEOF
python3 /tmp/openclaw_fix_auth.py; chmod 600 /root/.openclaw/agents/main/agent/auth-profiles.json`,
    { quiet: true }
  ).catch(() => null);
}

async function ensureGatewayToken() {
  const existing = (process.env.OPENCLAW_GATEWAY_TOKEN || '').trim();
  if (existing) return existing;

  const tokenPath = '/root/.openclaw/gateway_token';
  const remote = await executeRemote(
    `mkdir -p /root/.openclaw; ` +
      `if [ -f "${tokenPath}" ] && [ -s "${tokenPath}" ]; then cat "${tokenPath}"; ` +
      `else python3 -c "import secrets; print(secrets.token_hex(32))" > "${tokenPath}"; ` +
      `chmod 600 "${tokenPath}"; cat "${tokenPath}"; fi`,
    { quiet: true }
  );

  return remote.trim();
}

async function startGateway() {
  const port = process.env.OPENCLAW_GATEWAY_PORT || '18789';
  const runDir = '/root/.openclaw/run';
  const logPath = '/root/.openclaw/run/gateway.log';
  const pidPath = '/root/.openclaw/run/gateway.pid';
  const watchdogPath = '/root/.openclaw/run/gateway_watchdog.sh';
  const watchdogPidPath = '/root/.openclaw/run/gateway_watchdog.pid';
  const tokenPath = '/root/.openclaw/gateway_token';

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

  // Ensure Ollama is up before starting gateway. Some OpenClaw flows will hang if the backend is unreachable.
  const ollamaRunning = await executeRemote('pgrep -x ollama >/dev/null 2>&1 && echo yes || echo no', { quiet: true }).catch(() => 'no');
  if (ollamaRunning.trim() !== 'yes') {
    await executeRemote('nohup ollama serve > /tmp/ollama.log 2>&1 &', { quiet: true }).catch(() => null);
    await sleep(1500);
  }

  await executeRemote(`mkdir -p ${runDir}`, { quiet: true });

  // Stop any supervised gateway service and kill any stray gateway processes.
  // Note: OpenClaw may run as "openclaw-gateway" (not matching "openclaw gateway"), so we kill both patterns.
  await executeRemote('openclaw gateway stop 2>/dev/null || true', { quiet: true }).catch(() => null);
  await executeRemote('pkill -9 -f "openclaw-gateway" || true', { quiet: true }).catch(() => null);
  await executeRemote('pkill -9 -f "openclaw gateway" || true', { quiet: true }).catch(() => null);

  await executeRemote(
    `if [ -f ${watchdogPidPath} ]; then ` +
      `pid=$(cat ${watchdogPidPath} 2>/dev/null || true); ` +
      `if [ -n "$pid" ]; then kill -9 $pid 2>/dev/null || true; fi; ` +
      `rm -f ${watchdogPidPath}; ` +
      `fi`,
    { quiet: true }
  ).catch(() => null);

  // If a supervised process respawns or the name does not match, kill whatever is actually bound to the port.
  const portKillCmd =
    `pids=$(ss -ltnp 2>/dev/null | grep :${port} | sed -n 's/.*pid=\\([0-9]\\+\\).*/\\1/p' | head -n 10 | tr '\n' ' '); ` +
    `if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null || true; fi`;
  await executeRemote(portKillCmd, { quiet: true }).catch(() => null);

  // Wait for port to be free before starting.
  for (let i = 0; i < 10; i += 1) {
    const ssCheck = await executeRemote(`ss -ltnp 2>/dev/null | grep :${port} || true`, { quiet: true }).catch(() => '');
    const nsCheck = await executeRemote(`netstat -lntp 2>/dev/null | grep :${port} || true`, { quiet: true }).catch(() => '');
    const inUse = `${ssCheck}\n${nsCheck}`.includes(`:${port}`) || `${ssCheck}\n${nsCheck}`.includes(` ${port} `);
    if (!inUse) break;
    await sleep(500);
  }

  await executeRemote(`rm -f ${logPath} ${pidPath}`, { quiet: true });
  await executeRemote(`touch ${logPath} ${pidPath} && chmod 600 ${logPath} ${pidPath}`, { quiet: true });

  const watchdogScript =
    `#!/usr/bin/env bash\n` +
    `set -u\n` +
    `PORT="${port}"\n` +
    `TOKEN_PATH="${tokenPath}"\n` +
    `LOG_PATH="${logPath}"\n` +
    `PID_PATH="${pidPath}"\n` +
    `while true; do\n` +
    `  TOKEN=$(cat "$TOKEN_PATH" 2>/dev/null || echo "")\n` +
    `  if [ -z "$TOKEN" ]; then\n` +
    `    sleep 2\n` +
    `    continue\n` +
    `  fi\n` +
    `  OPENCLAW_GATEWAY_TOKEN="$TOKEN" openclaw gateway run --bind loopback --port "$PORT" --force --allow-unconfigured --auth token --verbose >> "$LOG_PATH" 2>&1 &\n` +
    `  echo $! > "$PID_PATH"\n` +
    `  wait $(cat "$PID_PATH" 2>/dev/null || echo "")\n` +
    `  sleep 1\n` +
    `done\n`;

  await executeRemote(
    `cat > ${watchdogPath} << 'EOF'\n${watchdogScript}EOF\n` +
      `chmod 700 ${watchdogPath}`,
    { quiet: true }
  );

  const startOut = await executeRemote(
    `nohup ${watchdogPath} > /dev/null 2>&1 & echo $! > ${watchdogPidPath}; ` +
      `sleep 1; cat ${watchdogPidPath} 2>/dev/null || true; ls -la ${runDir}`,
    { quiet: true }
  ).catch(e => `start error: ${e.message}`);
  if (process.env.VERBOSE) console.log('  [gateway start output]', startOut);

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
  const workspace = process.env.OPENCLAW_WORKSPACE || '~/mattyjacksbot/v1/agent_runtime/workspace';
  
  await executeRemote(`
    mkdir -p ${workspace}/skills
    mkdir -p ~/mattyjacksbot/v1/sync/public
    mkdir -p ~/mattyjacksbot/v1/sync/private
    mkdir -p ~/mattyjacksbot/v1/sync/artifacts
    mkdir -p ~/mattyjacksbot/v1/sync/state
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

export function getConnectionStatus() {
  const config = getConfig();
  
  if (!config.host) {
    return { connected: false, host: null };
  }
  
  return { 
    connected: sshConnection !== null, 
    host: config.host 
  };
}

export function disconnect() {
  if (sshConnection) {
    sshConnection.end();
    sshConnection = null;
  }
}
