import { Client } from 'ssh2';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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
    password: process.env.VAST_PASSWORD
  };
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
  
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', async () => {
      console.log('  SSH connection established');
      sshConnection = conn;
      
      try {
        await bootstrap(conn, options);
        resolve({ connected: true, host: config.host });
      } catch (error) {
        reject(error);
      }
    });
    
    conn.on('error', (err) => {
      reject(new Error(`SSH connection failed: ${err.message}`));
    });
    
    conn.connect(config);
  });
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
  
  if (vramGB < lowThreshold) {
    return `${family}:7b-q4_K_M`;
  } else if (vramGB < midThreshold) {
    return `${family}:7b-q5_K_M`;
  } else if (vramGB < highThreshold) {
    return `${family}:14b-q4_K_M`;
  } else {
    return `${family}:14b-q5_K_M`;
  }
}

async function pullModelForVRAM(vramGB) {
  const model = selectModelForVRAM(vramGB);
  console.log(`  Pulling model: ${model}`);
  
  await executeRemote(`ollama pull ${model}`, { verbose: true });
  
  await executeRemote(`echo "${model}" > ~/.openclaw/current_model`, { quiet: true });
}

async function ensureModelPulled(vramGB) {
  const model = selectModelForVRAM(vramGB);
  
  const currentModel = await executeRemote('cat ~/.openclaw/current_model 2>/dev/null || echo ""', { quiet: true });
  
  if (currentModel.trim() !== model) {
    console.log(`  Model mismatch, pulling: ${model}`);
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

async function startGateway() {
  const port = process.env.OPENCLAW_GATEWAY_PORT || '18789';
  
  await executeRemote(
    `pkill -9 -f "openclaw gateway" || true; ` +
    `nohup openclaw gateway run --bind loopback --port ${port} --force > /tmp/openclaw-gateway.log 2>&1 &`,
    { quiet: true }
  );
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const check = await executeRemote(`ss -ltnp | grep ${port}`, { quiet: true }).catch(() => '');
  
  if (!check.includes(port)) {
    throw new Error('Gateway failed to start');
  }
  
  console.log(`  Gateway running on port ${port}`);
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
  
  return new Promise((resolve, reject) => {
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
