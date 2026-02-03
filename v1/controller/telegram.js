import TelegramBot from 'node-telegram-bot-api';
import { getConnectionStatus, connect } from './ssh.js';
import { runSync, getSyncStatus } from './sync.js';
import { getAgentStatus, startAgent, stopAgent, setMoltbookMode, getPendingPosts, approvePost, rejectPost } from './agent.js';
import { applyBrainProposal, createBrainProposal, generateTextWithOllamaRemote, indexBrain, listBrainProposals, queryBrain } from './brain.js';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';

let bot = null;
let indexedOnce = false;
const processingChats = new Set();

function sendSafe(chatId, text, options) {
  if (!bot) return;
  const messageText = clampMessage(text);
  const opts = options || undefined;
  bot.sendMessage(chatId, messageText, opts).catch(() => {
    if (opts && opts.parse_mode) {
      bot.sendMessage(chatId, messageText).catch(() => {});
    }
  });
}

function getSyncRoot() {
  const configuredRoot = process.env.SYNC_ROOT;
  if (configuredRoot) {
    return configuredRoot.replace('%USERPROFILE%', homedir());
  }
  return join(homedir(), 'Documents', 'mattyjacksbot', 'v1');
}

function ensureDir(p) {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
  }
}

function telegramStateRoot() {
  const syncRoot = getSyncRoot();
  return join(syncRoot, 'artifacts', 'brain', 'telegram');
}

function loadTelegramPrefs() {
  const root = telegramStateRoot();
  const prefsPath = join(root, 'prefs.json');
  try {
    if (!existsSync(prefsPath)) return { users: {} };
    const parsed = JSON.parse(readFileSync(prefsPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return { users: {} };
    if (!parsed.users || typeof parsed.users !== 'object') parsed.users = {};
    return parsed;
  } catch {
    return { users: {} };
  }
}

function getOutputModeForUser(userId) {
  const prefs = loadTelegramPrefs();
  const u = prefs.users?.[String(userId)] || {};
  const mode = String(u.outputMode || 'focus');
  if (mode === 'full' || mode === 'thinking' || mode === 'focus') return mode;
  return 'focus';
}

function setOutputModeForUser(userId, mode) {
  const prefs = loadTelegramPrefs();
  if (!prefs.users) prefs.users = {};
  prefs.users[String(userId)] = { ...(prefs.users[String(userId)] || {}), outputMode: mode };
  ensureDir(telegramStateRoot());
  writeFileSync(join(telegramStateRoot(), 'prefs.json'), JSON.stringify(prefs, null, 2));
}

function getHelpMessage(userId) {
  return `
🤖 *MattyJacksBot Self Improving AI System*

Available commands:

/status - Show current status
/connect - Connect to Vast.ai
/sync - Run bidirectional sync
/start\_agent - Start the agent
/stop\_agent - Stop the agent
/logs - Get recent logs
/moltbook\_mode <mode> - Set mode (readonly/approval/autonomous)
/pending - List pending Moltbook posts
/approve <id> - Approve a pending post
/reject <id> - Reject a pending post

/output\_focus - Default output mode (short)
/output\_full - Show full outputs
/output\_thinking - Show extra reasoning summary

/browse <root|public|private|artifacts|brain> [path] - Browse files
/read <root|public|private|artifacts|brain> <path> - Read a file

/brain\_index - Index sync files into Brain
/brain\_query <query> - Search Brain
/brain\_proposals - List Brain proposals
/brain\_propose <subdir> <path> <instruction> - Create a file proposal
/brain\_apply <proposalId> - Apply a proposal

Your user ID: \`${userId}\`
  `;
}

function clampMessage(text, maxLen = 3800) {
  const t = String(text || '');
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}\n\n[truncated]`;
}

function safeParseJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function getChatLogPath(chatId) {
  const root = telegramStateRoot();
  return join(root, 'chats', `${String(chatId)}.jsonl`);
}

function appendChatLog(chatId, entry) {
  const root = join(telegramStateRoot(), 'chats');
  try {
    mkdirSync(root, { recursive: true });
    appendFileSync(getChatLogPath(chatId), `${JSON.stringify(entry)}\n`);
  } catch {
    // ignore
  }
}

function readRecentChat(chatId, maxLines = 18, maxChars = 6000) {
  const p = getChatLogPath(chatId);
  if (!existsSync(p)) return '';
  try {
    const raw = readFileSync(p, 'utf-8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(Math.max(0, lines.length - maxLines));
    const entries = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    const text = entries
      .map(e => `${e.role}: ${String(e.text || '').slice(0, 500)}`)
      .join('\n');
    return text.length > maxChars ? text.slice(text.length - maxChars) : text;
  } catch {
    return '';
  }
}

function resolveBrowseTarget(rootName, relPath) {
  const syncRoot = getSyncRoot();
  const allowed = new Set(['root', 'public', 'private', 'artifacts', 'brain']);
  if (!allowed.has(rootName)) throw new Error('Invalid root');

  const base = rootName === 'root'
    ? syncRoot
    : rootName === 'brain'
      ? join(syncRoot, 'artifacts', 'brain')
      : join(syncRoot, rootName);

  const safeRel = (relPath || '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (safeRel.includes('..')) throw new Error('Invalid path');

  const baseResolved = resolve(base);
  const absResolved = safeRel ? resolve(baseResolved, safeRel) : baseResolved;
  const baseLower = baseResolved.toLowerCase();
  const absLower = absResolved.toLowerCase();
  if (absLower !== baseLower && !absLower.startsWith(`${baseLower}\\`) && !absLower.startsWith(`${baseLower}/`)) {
    throw new Error('Invalid path');
  }

  return { base: baseResolved, abs: absResolved, safeRel };
}

function getAllowedUsers() {
  const allowed = process.env.TELEGRAM_ALLOWED_USER_IDS || '';
  return allowed.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
}

function getEnvPath() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return join(__dirname, '..', '.env');
}

function setEnvValueInFile(envPath, key, value) {
  let envContent = '';
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, 'utf-8');
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyRegex = new RegExp(`^${escapedKey}=.*$`, 'm');
  const line = `${key}=${value}`;

  if (envContent.match(keyRegex)) {
    envContent = envContent.replace(keyRegex, line);
  } else {
    if (envContent.length > 0 && !envContent.endsWith('\n')) {
      envContent += '\n';
    }
    envContent += `${line}\n`;
  }

  writeFileSync(envPath, envContent);
}

function ensureFirstUserAuthorized(userId) {
  const existing = getAllowedUsers();
  if (existing.length > 0) return false;

  const envPath = getEnvPath();
  try {
    setEnvValueInFile(envPath, 'TELEGRAM_ALLOWED_USER_IDS', String(userId));
    process.env.TELEGRAM_ALLOWED_USER_IDS = String(userId);
    return true;
  } catch {
    return false;
  }
}

function isAuthorized(userId) {
  const allowed = getAllowedUsers();
  return allowed.length === 0 || allowed.includes(userId);
}

export function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!token) {
    console.log('Telegram bot not configured (TELEGRAM_BOT_TOKEN missing)');
    return null;
  }
  
  bot = new TelegramBot(token, { polling: true });
  
  console.log('🤖 Telegram bot started');

  const knownCommands = new Set([
    '/start',
    '/status',
    '/connect',
    '/sync',
    '/start_agent',
    '/stop_agent',
    '/logs',
    '/moltbook_mode',
    '/pending',
    '/approve',
    '/reject',
    '/output_focus',
    '/output_full',
    '/output_thinking',
    '/browse',
    '/read',
    '/brain_index',
    '/brain_query',
    '/brain_proposals',
    '/brain_propose',
    '/brain_apply'
  ]);
  
  bot.onText(/\/start/, (msg) => {
    if (!isAuthorized(msg.from.id)) {
      const didAuthorize = ensureFirstUserAuthorized(msg.from.id);
      if (didAuthorize) {
        sendSafe(msg.chat.id, `✅ Authorized user ID: \`${msg.from.id}\` (saved to .env)`, { parse_mode: 'Markdown' });
      }
    }

    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    
    sendSafe(msg.chat.id, getHelpMessage(msg.from.id), { parse_mode: 'Markdown' });
  });

  bot.onText(/\/output_focus/, (msg) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    setOutputModeForUser(msg.from.id, 'focus');
    bot.sendMessage(msg.chat.id, '✅ Output mode set to focus');
  });

  bot.onText(/\/output_full/, (msg) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    setOutputModeForUser(msg.from.id, 'full');
    bot.sendMessage(msg.chat.id, '✅ Output mode set to full');
  });

  bot.onText(/\/output_thinking/, (msg) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    setOutputModeForUser(msg.from.id, 'thinking');
    bot.sendMessage(msg.chat.id, '✅ Output mode set to thinking');
  });

  bot.onText(/\/browse\s+(\S+)(?:\s+([\s\S]+))?/, (msg, match) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    try {
      const rootName = String(match[1] || '').trim();
      const relPath = String(match[2] || '').trim();
      const { abs, safeRel } = resolveBrowseTarget(rootName, relPath);
      const entries = readdirSync(abs, { withFileTypes: true }).slice(0, 50);
      let out = `Browse ${rootName}/${safeRel || ''}`.trim();
      out += '\n\n';
      for (const e of entries) {
        const name = e.name;
        if (e.isDirectory()) {
          out += `[DIR] ${name}\n`;
        } else {
          try {
            const s = statSync(join(abs, name));
            out += `${name} (${s.size} bytes)\n`;
          } catch {
            out += `${name}\n`;
          }
        }
      }
      bot.sendMessage(msg.chat.id, clampMessage(out));
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  bot.onText(/\/read\s+(\S+)\s+([\s\S]+)/, (msg, match) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    try {
      const rootName = String(match[1] || '').trim();
      const relPath = String(match[2] || '').trim();
      const { abs, safeRel } = resolveBrowseTarget(rootName, relPath);
      const s = statSync(abs);
      if (s.size > 200000) {
        bot.sendMessage(msg.chat.id, '❌ File too large to display');
        return;
      }
      const content = readFileSync(abs, 'utf-8');
      const header = `Read ${rootName}/${safeRel}`.trim();
      bot.sendMessage(msg.chat.id, clampMessage(`${header}\n\n${content}`));
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  bot.onText(/\/brain_index/, async (msg) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    try {
      const stats = indexBrain();
      indexedOnce = true;
      bot.sendMessage(msg.chat.id, clampMessage(JSON.stringify(stats, null, 2)));
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  bot.onText(/\/brain_query\s+([\s\S]+)/, async (msg, match) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    try {
      const q = String(match[1] || '').trim();
      if (!q) {
        bot.sendMessage(msg.chat.id, '❌ Missing query');
        return;
      }
      if (!indexedOnce) {
        try { indexBrain(); indexedOnce = true; } catch { /* ignore */ }
      }
      const result = queryBrain(q, { limit: 8 });
      bot.sendMessage(msg.chat.id, clampMessage(JSON.stringify(result, null, 2)));
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  bot.onText(/\/brain_proposals/, (msg) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    try {
      const proposals = listBrainProposals();
      const simplified = proposals.map(p => ({ id: p.id, createdAt: p.createdAt, target: p.target, appliedAt: p.appliedAt }));
      bot.sendMessage(msg.chat.id, clampMessage(JSON.stringify(simplified, null, 2)));
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  bot.onText(/\/brain_apply\s+(\S+)/, (msg, match) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    try {
      const proposalId = String(match[1] || '').trim();
      const result = applyBrainProposal({ proposalId, allowOverwrite: false });
      bot.sendMessage(msg.chat.id, clampMessage(JSON.stringify(result, null, 2)));
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  bot.onText(/\/brain_propose\s+(public|private|artifacts)\s+(\S+)\s+([\s\S]+)/, async (msg, match) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    try {
      const subdir = String(match[1] || '').trim();
      const path = String(match[2] || '').trim();
      const instruction = String(match[3] || '').trim();
      if (!indexedOnce) {
        try { indexBrain(); indexedOnce = true; } catch { /* ignore */ }
      }
      const created = await createBrainProposal({ subdir, path, instruction, contextQuery: instruction, allowOverwrite: false, autoIndex: false });
      bot.sendMessage(msg.chat.id, clampMessage(JSON.stringify(created, null, 2)));
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });
  
  bot.onText(/\/status/, async (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    
    try {
      const [connection, sync, agent] = await Promise.all([
        getConnectionStatus(),
        getSyncStatus(),
        getAgentStatus()
      ]);
      
      const statusMsg = `
📊 *Status*

*Connection:*
• Host: \`${connection.host || 'Not configured'}\`
• Status: ${connection.connected ? '✅ Connected' : '❌ Disconnected'}

*Sync:*
• Last sync: ${sync.lastSync || 'Never'}
• Public files: ${sync.publicFiles}
• Private files: ${sync.privateFiles}
• Artifacts: ${sync.artifactFiles}

*Agent:*
• Status: ${agent.running ? '✅ Running' : '⏹ Stopped'}
• Model: \`${agent.model || 'Not loaded'}\`
• VRAM: ${agent.vram || 'Unknown'}
• Moltbook: ${agent.moltbookMode}
      `;
      
      sendSafe(msg.chat.id, statusMsg, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
    }
  });
  
  bot.onText(/\/connect/, async (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    
    bot.sendMessage(msg.chat.id, '🔄 Connecting to Vast.ai...');
    
    try {
      await connect({ force: false, verbose: false });
      bot.sendMessage(msg.chat.id, '✅ Connected successfully!');
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Connection failed: ${error.message}`);
    }
  });
  
  bot.onText(/\/sync/, async (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    
    bot.sendMessage(msg.chat.id, '🔄 Running sync...');
    
    try {
      const result = await runSync({ dryRun: false, verbose: false });
      
      sendSafe(msg.chat.id, `
✅ *Sync Complete*

↑ Uploaded: ${result.uploaded} files
↓ Downloaded: ${result.downloaded} files
⚠ Conflicts: ${result.conflicts.length}
      `, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Sync failed: ${error.message}`);
    }
  });
  
  bot.onText(/\/start_agent/, async (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    
    bot.sendMessage(msg.chat.id, '🚀 Starting agent...');
    
    try {
      await startAgent();
      bot.sendMessage(msg.chat.id, '✅ Agent started!');
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Failed to start agent: ${error.message}`);
    }
  });
  
  bot.onText(/\/stop_agent/, async (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    
    bot.sendMessage(msg.chat.id, '🛑 Stopping agent...');
    
    try {
      await stopAgent();
      bot.sendMessage(msg.chat.id, '✅ Agent stopped!');
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Failed to stop agent: ${error.message}`);
    }
  });
  
  bot.onText(/\/moltbook_mode (.+)/, async (msg, match) => {
    if (!isAuthorized(msg.from.id)) return;
    
    const mode = match[1].trim();
    const validModes = ['readonly', 'approval', 'autonomous'];
    
    if (!validModes.includes(mode)) {
      bot.sendMessage(msg.chat.id, `❌ Invalid mode. Must be one of: ${validModes.join(', ')}`);
      return;
    }
    
    try {
      await setMoltbookMode(mode);
      bot.sendMessage(msg.chat.id, `✅ Moltbook mode set to: ${mode}`);
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Failed: ${error.message}`);
    }
  });
  
  bot.onText(/\/pending/, async (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    
    try {
      const pending = await getPendingPosts();
      
      if (pending.length === 0) {
        bot.sendMessage(msg.chat.id, '📭 No pending posts');
        return;
      }
      
      let message = '📬 *Pending Posts*\n\n';
      
      for (const post of pending) {
        message += `*ID:* \`${post.id}\`\n`;
        message += `*Content:* ${post.content.substring(0, 100)}...\n`;
        message += `*Created:* ${post.createdAt}\n\n`;
      }
      
      message += 'Use /approve <id> or /reject <id>';
      
      sendSafe(msg.chat.id, message, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Failed: ${error.message}`);
    }
  });
  
  bot.onText(/\/approve (.+)/, async (msg, match) => {
    if (!isAuthorized(msg.from.id)) return;
    
    const postId = match[1].trim();
    
    try {
      await approvePost(postId);
      bot.sendMessage(msg.chat.id, `✅ Post ${postId} approved!`);
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Failed: ${error.message}`);
    }
  });
  
  bot.onText(/\/reject (.+)/, async (msg, match) => {
    if (!isAuthorized(msg.from.id)) return;
    
    const postId = match[1].trim();
    
    try {
      await rejectPost(postId);
      bot.sendMessage(msg.chat.id, `✅ Post ${postId} rejected`);
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Failed: ${error.message}`);
    }
  });
  
  bot.onText(/\/logs/, async (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    
    try {
      const { executeRemote } = await import('./ssh.js');
      const logs = await executeRemote(
        'tail -n 30 /tmp/openclaw-gateway.log 2>/dev/null || echo "No logs"',
        { quiet: true }
      );
      
      bot.sendMessage(msg.chat.id, clampMessage(logs.substring(0, 4000))).catch(() => {});
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Failed: ${error.message}`);
    }
  });

  bot.on('message', async (msg) => {
    const text = (msg.text || '').trim();
    if (!text) return;

    if (text.startsWith('/')) {
      const cmd = text.split(/\s+/)[0];
      if (!knownCommands.has(cmd)) {
        if (!isAuthorized(msg.from.id)) {
          bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
          return;
        }
        sendSafe(msg.chat.id, `❌ Unknown command: \`${cmd}\`\n\nSend /start to see available commands.`, { parse_mode: 'Markdown' });
      }
      return;
    }

    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }

    if (processingChats.has(msg.chat.id)) {
      bot.sendMessage(msg.chat.id, '⏳ Still working on the previous message...');
      return;
    }

    processingChats.add(msg.chat.id);
    try {
      appendChatLog(msg.chat.id, { t: new Date().toISOString(), role: 'user', text });

      if (!indexedOnce) {
        try { indexBrain(); indexedOnce = true; } catch { /* ignore */ }
      }

      const outputMode = getOutputModeForUser(msg.from.id);
      const history = readRecentChat(msg.chat.id);
      const ctx = queryBrain(text, { limit: 6 });
      const blocks = (ctx.results || []).slice(0, 6).map(r => `FILE: ${r.docKey}\n${r.preview}`).join('\n\n');

      const prompt =
        `You are MattyJacksBot Self Improving AI System.\n` +
        `You can help the user operate OpenClaw on Vast.ai and manage files in the synced workspace.\n` +
        `For any suggested file changes, propose them and mention the Brain proposal commands.\n` +
        `\n` +
        `Conversation (recent):\n${history || '(none)'}\n\n` +
        (blocks ? `Relevant synced file context:\n${blocks}\n\n` : '') +
        `User message: ${text}\n\n` +
        `Return a single JSON object with keys: response, thinking, debug.\n` +
        `response should be what you want the user to see by default.\n` +
        `thinking should be a short reasoning summary (no private chain-of-thought).\n` +
        `debug can include extra details and any internal notes.\n`;

      const raw = await generateTextWithOllamaRemote(prompt);
      const parsed = safeParseJson(raw);
      const response = parsed?.response ? String(parsed.response) : String(raw || '');
      const thinking = parsed?.thinking ? String(parsed.thinking) : '';
      const debug = parsed?.debug ? String(parsed.debug) : '';

      appendChatLog(msg.chat.id, { t: new Date().toISOString(), role: 'assistant', text: response });

      if (outputMode === 'full') {
        const extra = `\n\n[mode: full]\n\nThinking:\n${thinking || '(none)'}\n\nDebug:\n${debug || '(none)'}`;
        bot.sendMessage(msg.chat.id, clampMessage(`${response}${extra}`));
      } else if (outputMode === 'thinking') {
        const extra = `\n\n[mode: thinking]\n\nThinking:\n${thinking || '(none)'}`;
        bot.sendMessage(msg.chat.id, clampMessage(`${response}${extra}`));
      } else {
        bot.sendMessage(msg.chat.id, clampMessage(response));
      }
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ AI error: ${e.message}`);
    } finally {
      processingChats.delete(msg.chat.id);
    }
  });
  
  return bot;
}

export function stopTelegramBot() {
  if (bot) {
    bot.stopPolling();
    bot = null;
  }
}

export function sendTelegramNotification(message) {
  if (!bot) return;
  
  const allowed = getAllowedUsers();
  for (const userId of allowed) {
    bot.sendMessage(userId, message, { parse_mode: 'Markdown' }).catch(() => {});
  }
}
