import TelegramBot from 'node-telegram-bot-api';
import { getConnectionStatus, connect } from './ssh.js';
import { runSync, getSyncStatus } from './sync.js';
import { getAgentStatus, startAgent, stopAgent, setMoltbookMode, getPendingPosts, approvePost, rejectPost } from './agent.js';

let bot = null;

function getAllowedUsers() {
  const allowed = process.env.TELEGRAM_ALLOWED_USER_IDS || '';
  return allowed.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
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
  
  bot.onText(/\/start/, (msg) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    
    bot.sendMessage(msg.chat.id, `
🦞 *Moltbook + OpenClaw v1 Control*

Available commands:

/status - Show current status
/connect - Connect to Vast.ai
/sync - Run bidirectional sync
/start\\_agent - Start the agent
/stop\\_agent - Stop the agent
/logs - Get recent logs
/moltbook\\_mode <mode> - Set mode (readonly/approval/autonomous)
/pending - List pending Moltbook posts
/approve <id> - Approve a pending post
/reject <id> - Reject a pending post

Your user ID: \`${msg.from.id}\`
    `, { parse_mode: 'Markdown' });
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
      
      bot.sendMessage(msg.chat.id, statusMsg, { parse_mode: 'Markdown' });
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
      
      bot.sendMessage(msg.chat.id, `
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
      
      bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
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
      
      bot.sendMessage(msg.chat.id, `\`\`\`\n${logs.substring(0, 4000)}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch (error) {
      bot.sendMessage(msg.chat.id, `❌ Failed: ${error.message}`);
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
