import { executeRemote } from './ssh.js';
import chalk from 'chalk';

export async function tailLogs(options = {}) {
  const { lines = 50, follow = false } = options;
  
  console.log(chalk.blue.bold('\n📋 OpenClaw Gateway Logs\n'));
  
  if (follow) {
    console.log(chalk.gray('(Press Ctrl+C to stop following)\n'));
    
    await streamLogs();
  } else {
    const logs = await getRecentLogs(lines);
    console.log(logs);
  }
}

async function getRecentLogs(lines) {
  try {
    const gatewayLogs = await executeRemote(
      `tail -n ${lines} /tmp/openclaw-gateway.log 2>/dev/null || echo "No gateway logs found"`,
      { quiet: true }
    );
    
    return formatLogs(gatewayLogs);
  } catch (error) {
    return `Error fetching logs: ${error.message}`;
  }
}

async function streamLogs() {
  const { Client } = await import('ssh2');
  const { readFileSync } = await import('fs');
  const { homedir } = await import('os');
  
  const config = {
    host: process.env.VAST_HOST,
    port: parseInt(process.env.VAST_PORT || '22'),
    username: process.env.VAST_USER || 'root',
    privateKey: process.env.VAST_SSH_KEY_PATH 
      ? readFileSync(process.env.VAST_SSH_KEY_PATH.replace('~', homedir()))
      : undefined,
    password: process.env.VAST_PASSWORD
  };
  
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', () => {
      conn.exec('tail -f /tmp/openclaw-gateway.log', (err, stream) => {
        if (err) {
          reject(err);
          return;
        }
        
        stream.on('data', (data) => {
          process.stdout.write(formatLogs(data.toString()));
        });
        
        stream.stderr.on('data', (data) => {
          process.stderr.write(chalk.red(data.toString()));
        });
        
        stream.on('close', () => {
          conn.end();
          resolve();
        });
        
        process.on('SIGINT', () => {
          console.log(chalk.yellow('\nStopping log stream...'));
          conn.end();
          resolve();
        });
      });
    });
    
    conn.on('error', reject);
    conn.connect(config);
  });
}

function formatLogs(raw) {
  const lines = raw.split('\n');
  
  return lines.map(line => {
    if (line.includes('error') || line.includes('Error') || line.includes('ERROR')) {
      return chalk.red(line);
    }
    if (line.includes('warn') || line.includes('Warn') || line.includes('WARN')) {
      return chalk.yellow(line);
    }
    if (line.includes('info') || line.includes('Info') || line.includes('INFO')) {
      return chalk.cyan(line);
    }
    if (line.includes('debug') || line.includes('Debug') || line.includes('DEBUG')) {
      return chalk.gray(line);
    }
    return line;
  }).join('\n');
}

export async function getOllamaLogs(lines = 50) {
  try {
    const logs = await executeRemote(
      `tail -n ${lines} /tmp/ollama.log 2>/dev/null || echo "No Ollama logs found"`,
      { quiet: true }
    );
    return formatLogs(logs);
  } catch (error) {
    return `Error fetching Ollama logs: ${error.message}`;
  }
}
