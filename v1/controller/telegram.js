import TelegramBot from 'node-telegram-bot-api';
import { getConnectionStatus, connect } from './ssh.js';
import { runSync, getSyncStatus } from './sync.js';
import { getAgentStatus, startAgent, stopAgent, setMoltbookMode, getPendingPosts, approvePost, rejectPost } from './agent.js';
import { applyBrainProposal, createBrainProposal, createBrainProposalFromGenerated, generateTextWithOllamaRemote, indexBrain, listBrainProposals, queryBrain } from './brain.js';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

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

function clampTextChars(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

function trimUrlPunctuation(u) {
  return String(u || '').trim().replace(/[)\],.!?;:]+$/g, '');
}

function normalizeUrlLike(input) {
  const raw = trimUrlPunctuation(input);
  if (!raw) return null;
  if (raw.toLowerCase().startsWith('http://') || raw.toLowerCase().startsWith('https://')) return raw;
  if (raw.toLowerCase().startsWith('www.')) return `https://${raw}`;
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[\S]*)?$/i.test(raw)) {
    return `https://${raw}`;
  }
  return null;
}

function extractUrlsFromText(text) {
  const s = String(text || '');
  const urls = [];
  const re = /https?:\/\/[\w\-._~:/?#\[\]@!$&'()*+,;=%]+/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const norm = normalizeUrlLike(m[0]);
    if (!norm) continue;
    if (isAllowedUrl(norm)) urls.push(norm);
    if (urls.length >= 5) break;
  }

  if (urls.length < 5) {
    const reBare = /\b(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[\S]*)?\b/gi;
    while ((m = reBare.exec(s)) !== null) {
      const startIdx = m.index || 0;
      if (startIdx > 0 && s[startIdx - 1] === '@') continue;
      const norm = normalizeUrlLike(m[0]);
      if (!norm) continue;
      if (urls.includes(norm)) continue;
      if (isAllowedUrl(norm)) urls.push(norm);
      if (urls.length >= 5) break;
    }
  }

  return urls;
}

function isBlockedHostname(hostname) {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '127.0.0.1' || h === '::1') return true;

  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h);
  if (isIpv4) {
    const parts = h.split('.').map(n => parseInt(n, 10));
    if (parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  if (h.includes(':')) {
    if (h.startsWith('fe80:')) return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
  }

  return false;
}

function shouldAutoCrawlFromUserText(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('crawl') ||
    t.includes('scan the site') ||
    t.includes('read the docs') ||
    t.includes('look through the site') ||
    t.includes('check the whole site') ||
    t.includes('find all pages')
  );
}

function shouldAutoSearchFromUserText(text) {
  const t = String(text || '').toLowerCase();
  const hasUrl = extractUrlsFromText(text).length > 0;
  if (hasUrl) return false;
  const looksLikeQuestion = t.includes('?') || t.startsWith('what ') || t.startsWith('how ') || t.startsWith('why ') || t.startsWith('when ');
  const webHint = t.includes('latest') || t.includes('news') || t.includes('release') || t.includes('pricing') || t.includes('docs') || t.includes('documentation');
  return looksLikeQuestion && webHint;
}

async function braveWebSearch(query, options = {}) {
  const key = String(process.env.BRAVE_API_KEY || '').trim();
  if (!key) throw new Error('BRAVE_API_KEY missing');

  const { count = 5 } = options;
  const apiUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${encodeURIComponent(String(count))}&safesearch=moderate`;
  const res = await fetch(apiUrl, {
    headers: {
      'X-Subscription-Token': key,
      'Accept': 'application/json',
      'User-Agent': 'MattyJacksBot/1.0'
    }
  });
  if (!res.ok) throw new Error(`Brave search HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.web?.results;
  if (!Array.isArray(results)) return [];
  return results
    .slice(0, count)
    .map(r => ({
      title: String(r?.title || ''),
      url: String(r?.url || ''),
      description: String(r?.description || '')
    }))
    .filter(r => r.url);
}

function formatSearchResults(results) {
  const lines = [];
  for (const r of results) {
    lines.push(`- ${r.title}\n  ${r.url}\n  ${r.description}`.trim());
  }
  return lines.join('\n');
}

function isValidWebAction(action) {
  return action === 'visit' || action === 'crawl' || action === 'search';
}

async function runWebActions(actions) {
  const out = [];
  const list = Array.isArray(actions) ? actions.slice(0, 2) : [];
  for (const a of list) {
    const action = String(a?.action || '').trim();
    if (!isValidWebAction(action)) continue;

    if (action === 'visit') {
      const url = String(a?.url || '').trim();
      if (!url) continue;
      try {
        const fetched = await safeFetchUrl(url);
        const text = clampTextChars(stripHtmlToText(fetched.body, fetched.url), 10000);
        out.push(`VISIT URL: ${fetched.url}\nTEXT: ${text}`);
      } catch {
        continue;
      }
    }

    if (action === 'crawl') {
      const url = String(a?.url || '').trim();
      if (!url) continue;
      const maxPages = Math.min(8, Math.max(1, parseInt(String(a?.maxPages || '5'))));
      const maxDepth = Math.min(2, Math.max(0, parseInt(String(a?.maxDepth || '1'))));
      try {
        const pages = await crawlWebsite(url, { maxPages, maxDepth, perPageMaxChars: 9000 });
        const joined = pages.map(p => `CRAWL URL: ${p.url}\nTEXT: ${clampTextChars(p.text, 9000)}`).join('\n\n---\n\n');
        out.push(joined);
      } catch {
        continue;
      }
    }

    if (action === 'search') {
      const query = String(a?.query || '').trim();
      if (!query) continue;
      try {
        const results = await braveWebSearch(query, { count: 5 });
        out.push(`SEARCH QUERY: ${query}\nRESULTS:\n${formatSearchResults(results)}`);
      } catch {
        continue;
      }
    }
  }

  return clampTextChars(out.join('\n\n'), 26000);
}

async function gatherAutoWebContext(userText) {
  const urls = extractUrlsFromText(userText);
  const out = [];

  if (urls.length > 0) {
    if (shouldAutoCrawlFromUserText(userText)) {
      try {
        const pages = await crawlWebsite(urls[0], { maxPages: 6, maxDepth: 1, perPageMaxChars: 9000 });
        const joined = pages.map(p => `CRAWL URL: ${p.url}\nTEXT: ${clampTextChars(p.text, 9000)}`).join('\n\n---\n\n');
        out.push(joined);
      } catch {
        // ignore
      }
    } else {
      for (const u of urls.slice(0, 2)) {
        try {
          const fetched = await safeFetchUrl(u);
          const text = clampTextChars(stripHtmlToText(fetched.body, fetched.url), 12000);
          out.push(`VISIT URL: ${fetched.url}\nTEXT: ${text}`);
        } catch {
          continue;
        }
      }
    }
  }

  if (shouldAutoSearchFromUserText(userText)) {
    try {
      const results = await braveWebSearch(userText, { count: 5 });
      out.push(`SEARCH RESULTS:\n${formatSearchResults(results)}`);
      const top = results.filter(r => isAllowedUrl(r.url)).slice(0, 1);
      for (const r of top) {
        try {
          const fetched = await safeFetchUrl(r.url);
          const text = clampTextChars(stripHtmlToText(fetched.body, fetched.url), 9000);
          out.push(`TOP RESULT VISIT URL: ${fetched.url}\nTEXT: ${text}`);
        } catch {
          continue;
        }
      }
    } catch {
      // ignore
    }
  }

  return clampTextChars(out.join('\n\n'), 26000);
}

function isAllowedUrl(u) {
  try {
    const url = new URL(u);
    if (!(url.protocol === 'http:' || url.protocol === 'https:')) return false;
    if (isBlockedHostname(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

async function safeFetchUrl(url, options = {}) {
  const {
    timeoutMs = 12000,
    maxBytes = 600000,
    userAgent = 'MattyJacksBot/1.0'
  } = options;

  const norm = normalizeUrlLike(url) || String(url || '').trim();
  if (!isAllowedUrl(norm)) throw new Error('URL not allowed');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(norm, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/pdf')) {
      throw new Error('PDF not supported');
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`Response too large (${buf.length} bytes)`);
    }

    const body = buf.toString('utf-8');
    return { url: res.url || norm, contentType: ct, body };
  } finally {
    clearTimeout(timer);
  }
}

function stripHtmlToText(html, url) {
  const s = String(html || '');
  if (!s.trim()) return '';

  try {
    const dom = new JSDOM(s, { url: url || 'https://example.com/' });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const primary = String(article?.textContent || '').trim();
    if (primary) {
      return primary.replace(/\s+/g, ' ').trim();
    }
  } catch {
    // fall back below
  }

  try {
    const $ = cheerio.load(s);
    $('script,style,noscript').remove();
    const text = $.root().text();
    return String(text || '').replace(/\s+/g, ' ').trim();
  } catch {
    return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function extractLinks(html, baseUrl) {
  const s = String(html || '');
  const out = [];
  try {
    const $ = cheerio.load(s);
    $('a[href]').each((_, el) => {
      const raw = String($(el).attr('href') || '').trim();
      if (!raw) return;
      if (raw.startsWith('#')) return;
      if (raw.startsWith('mailto:') || raw.startsWith('javascript:')) return;
      try {
        const abs = new URL(raw, baseUrl).toString();
        if (isAllowedUrl(abs)) out.push(abs);
      } catch {
        return;
      }
    });
  } catch {
    return [];
  }

  const uniq = [];
  const seen = new Set();
  for (const u of out) {
    if (seen.has(u)) continue;
    seen.add(u);
    uniq.push(u);
    if (uniq.length > 2000) break;
  }
  return uniq;
}

async function crawlWebsite(startUrl, options = {}) {
  const {
    maxPages = 5,
    maxDepth = 1,
    perPageMaxChars = 12000
  } = options;

  const start = new URL(startUrl);
  const startHost = start.host;

  const visited = new Set();
  const queue = [{ url: start.toString(), depth: 0 }];
  const pages = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    let fetched;
    try {
      fetched = await safeFetchUrl(url);
    } catch {
      continue;
    }

    const text = clampTextChars(stripHtmlToText(fetched.body, fetched.url), perPageMaxChars);
    pages.push({ url: fetched.url, text });

    if (depth >= maxDepth) continue;
    const links = extractLinks(fetched.body, fetched.url);

    const scored = links
      .map(link => {
        const lower = link.toLowerCase();
        let score = 0;
        if (lower.includes('docs') || lower.includes('documentation')) score += 5;
        if (lower.includes('api')) score += 4;
        if (lower.includes('guide') || lower.includes('tutorial')) score += 3;
        if (lower.includes('reference')) score += 3;
        if (lower.includes('blog')) score += 1;
        return { link, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 120)
      .map(x => x.link);

    for (const link of scored) {
      try {
        const u = new URL(link);
        if (u.host !== startHost) continue;
        const normalized = u.toString();
        if (!visited.has(normalized)) {
          queue.push({ url: normalized, depth: depth + 1 });
        }
      } catch {
        continue;
      }
      if (queue.length > 200) break;
    }
  }

  return pages;
}

async function generateDocumentContentsForFile(userText, assistantResponse, targetPath) {
  const prompt =
    `You are generating the full contents of a single markdown document file.\n` +
    `Return only the document contents. Do not mention that you created a file. Do not include file paths.\n` +
    `Do not wrap in code fences.\n\n` +
    `Target path: ${targetPath}\n\n` +
    `User request: ${userText}\n\n` +
    `If helpful, you can incorporate this draft response, but rewrite it as a proper document:\n` +
    `${String(assistantResponse || '').slice(0, 2500)}\n\n` +
    `Now output the final markdown document contents:`;

  const raw = await generateTextWithOllamaRemote(prompt);
  return String(raw || '').trim();
}

function responseLooksLikeMetaAboutFile(text) {
  const t = String(text || '').toLowerCase();
  return (
    t.includes('i created a file') ||
    t.includes("i've created a file") ||
    t.includes('created a file titled') ||
    t.includes('saved it to') ||
    t.includes('file has been created')
  );
}

function makeSlugFromText(text, maxLen = 48) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[`'"\[\](){}<>]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  const trimmed = t.slice(0, maxLen).replace(/_+$/g, '');
  return trimmed || 'document';
}

function defaultGeneratedFilePathForRequest(userText) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = makeSlugFromText(userText);
  return `generated/${slug}_${stamp}.md`;
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

function isContextFooterEnabledForUser(userId) {
  const prefs = loadTelegramPrefs();
  const u = prefs.users?.[String(userId)] || {};
  return !!u.contextFooter;
}

function toggleContextFooterForUser(userId) {
  const prefs = loadTelegramPrefs();
  if (!prefs.users) prefs.users = {};
  const current = prefs.users[String(userId)] || {};
  const next = !current.contextFooter;
  prefs.users[String(userId)] = { ...current, contextFooter: next };
  ensureDir(telegramStateRoot());
  writeFileSync(join(telegramStateRoot(), 'prefs.json'), JSON.stringify(prefs, null, 2));
  return next;
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

/context - Toggle context footer (token estimates + model context limit)

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

function estimateTokens(text) {
  const s = String(text || '');
  return Math.max(1, Math.ceil(s.length / 4));
}

function getModelContextLimit() {
  const raw = String(process.env.MODEL_CONTEXT_LIMIT || '').trim();
  const parsed = parseInt(raw || '');
  if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  return 32768;
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

function extractJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = s.slice(start, end + 1).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function wantsFile(text) {
  const t = String(text || '').toLowerCase();
  const patterns = [
    /\bmake\s+me\s+a\s+file\b/,
    /\bmake\s+a\s+file\b/,
    /\bcreate\s+a\s+file\b/,
    /\bwrite\s+to\s+a\s+file\b/,
    /\bsave\s+this\s+to\s+a\s+file\b/,
    /\bsave\s+this\s+as\s+(a\s+)?file\b/,
    /\bsave\s+it\s+as\s+(a\s+)?file\b/,
    /\bsave\s+it\s+to\s+(a\s+)?file\b/,
    /\bput\s+this\s+in\s+(a\s+)?file\b/,
    /\bwrite\s+this\s+to\s+(a\s+)?file\b/,
    /\band\s+make\s+a\s+file\b/,
    /\band\s+create\s+a\s+file\b/
  ];
  return patterns.some(p => p.test(t));
}

function getWebMemoryPath() {
  const syncRoot = getSyncRoot();
  return join(syncRoot, 'artifacts', 'web', 'telegram_web_memory.md');
}

function prependWebMemoryEntry(entryMarkdown, maxChars = 18000) {
  try {
    const abs = getWebMemoryPath();
    ensureDir(dirname(abs));
    const existing = existsSync(abs) ? readFileSync(abs, 'utf-8') : '';
    let next = `${String(entryMarkdown || '').trim()}\n\n${existing}`;
    if (next.length > maxChars) next = next.slice(0, maxChars);
    writeFileSync(abs, next);
  } catch {
    // ignore
  }
}

function seemsLikeDocumentRequest(text) {
  const t = String(text || '').toLowerCase();
  const docWords = [
    'write', 'generate', 'draft', 'create', 'make',
    'document', 'doc', 'markdown', 'notes', 'guide', 'report', 'spec', 'specification',
    'proposal', 'plan', 'outline'
  ];
  const hasDocKeyword = docWords.some(w => t.includes(w));
  const isControlCommandLike = t.startsWith('/') || t.startsWith('connect ') || t.startsWith('sync ') || t.startsWith('status ');
  return hasDocKeyword && !isControlCommandLike;
}

async function classifyFileIntentWithAI(userText, assistantResponse) {
  try {
    const prompt =
      `Decide if the user likely wants the assistant to save output as a file.\n` +
      `Return only JSON: {"fileIntent":true|false,"subdir":"public"|"private"|"artifacts","path":"relative/path.md"}.\n` +
      `If unsure, prefer false.\n\n` +
      `User: ${userText}\n\n` +
      `Assistant: ${String(assistantResponse || '').slice(0, 1200)}\n`;

    const raw = await generateTextWithOllamaRemote(prompt);
    const parsed = safeParseJson(raw) || extractJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const fileIntent = !!parsed.fileIntent;
    const subdir = String(parsed.subdir || 'private');
    const path = String(parsed.path || '').trim();
    if (!['public', 'private', 'artifacts'].includes(subdir)) return { fileIntent, subdir: 'private', path: '' };
    return { fileIntent, subdir, path };
  } catch {
    return null;
  }
}

function defaultGeneratedFilePath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `generated/telegram_${stamp}.md`;
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
    '/context',
    '/browse',
    '/read',
    '/brain_index',
    '/brain_query',
    '/brain_proposals',
    '/brain_propose',
    '/brain_apply',
    '/visit',
    '/crawl'
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

  bot.onText(/\/context/, (msg) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }
    const enabled = toggleContextFooterForUser(msg.from.id);
    bot.sendMessage(msg.chat.id, enabled ? '✅ Context footer enabled' : '✅ Context footer disabled');
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

  bot.onText(/\/visit\s+([\s\S]+)/, async (msg, match) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }

    const url = String(match[1] || '').trim();
    if (!url) {
      bot.sendMessage(msg.chat.id, '❌ Missing URL');
      return;
    }

    bot.sendMessage(msg.chat.id, '🌐 Visiting...');
    try {
      const fetched = await safeFetchUrl(url);
      const pageText = clampTextChars(stripHtmlToText(fetched.body, fetched.url), 14000);
      const prompt =
        `Summarize the following web page for the user.\n` +
        `Include: what it is, key points, and any actionable items.\n` +
        `Be concise.\n\n` +
        `URL: ${fetched.url}\n\n` +
        `PAGE TEXT:\n${pageText}`;

      const summary = await generateTextWithOllamaRemote(prompt);
      bot.sendMessage(msg.chat.id, clampMessage(`Visited: ${fetched.url}\n\n${String(summary || '').trim()}`));
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  bot.onText(/\/crawl\s+(\S+)(?:\s+(\d+))?(?:\s+(\d+))?/, async (msg, match) => {
    if (!isAuthorized(msg.from.id)) {
      bot.sendMessage(msg.chat.id, '⛔ Unauthorized. Your user ID is not in the allowed list.');
      return;
    }

    const url = String(match[1] || '').trim();
    const maxPages = Math.min(12, Math.max(1, parseInt(match[2] || '5')));
    const maxDepth = Math.min(3, Math.max(0, parseInt(match[3] || '1')));

    if (!url) {
      bot.sendMessage(msg.chat.id, '❌ Missing URL');
      return;
    }

    bot.sendMessage(msg.chat.id, `🕸 Crawling (pages=${maxPages}, depth=${maxDepth})...`);
    try {
      const pages = await crawlWebsite(url, { maxPages, maxDepth });
      if (pages.length === 0) {
        bot.sendMessage(msg.chat.id, '❌ No pages fetched');
        return;
      }

      const joined = pages
        .map(p => `URL: ${p.url}\nTEXT: ${clampTextChars(p.text, 9000)}`)
        .join('\n\n---\n\n');

      const prompt =
        `You are summarizing a small crawl of a website.\n` +
        `Return: site overview, key sections/pages discovered, and key takeaways.\n` +
        `Also provide a short list of the most relevant URLs.\n\n` +
        `CRAWL DATA:\n${joined}`;

      const summary = await generateTextWithOllamaRemote(prompt);
      const urlsList = pages.slice(0, 10).map(p => `- ${p.url}`).join('\n');
      bot.sendMessage(msg.chat.id, clampMessage(`Crawled ${pages.length} pages from ${url}\n\nTop URLs:\n${urlsList}\n\n${String(summary || '').trim()}`));
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

      let webContext = '';
      try {
        webContext = await gatherAutoWebContext(text);
      } catch {
        webContext = '';
      }

      const prompt =
        `You are MattyJacksBot Self Improving AI System.\n` +
        `You can help the user operate OpenClaw on Vast.ai and manage files in the synced workspace.\n` +
        `You can browse the web: the system can visit URLs, crawl websites within limits, and provide you extracted page text. Do not claim you cannot visit websites.\n` +
        `Only create files when the user explicitly asks you to save/write/make a file.\n` +
        `When the user explicitly asks to create a file, you MUST include it in the JSON output under files.\n` +
        `If you are creating a file, put the actual file contents in files[].contents (not in response).\n` +
        `response should never say things like "I created a file". Instead, response should contain the useful answer itself.\n` +
        `If needed, you may request web actions in web: [{action:"visit"|"crawl"|"search", url, query, maxPages, maxDepth}].\n` +
        `You have access to a Brain index of synced files and a Brain proposal system.\n` +
        `Your answer should be grounded in the provided file context and recent conversation.\n` +
        `\n` +
        `Conversation (recent):\n${history || '(none)'}\n\n` +
        (blocks ? `Relevant synced file context:\n${blocks}\n\n` : '') +
        (webContext ? `Web context (auto):\n${webContext}\n\n` : '') +
        `User message: ${text}\n\n` +
        `Return only a single JSON object with keys: response, thinking, debug, contextQuery, files, fileIntent, fileSubdir, filePath, web.\n` +
        `Do not include any extra commentary or markdown outside the JSON.\n` +
        `response should be what you want the user to see by default.\n` +
        `thinking should be a short reasoning summary (no private chain-of-thought).\n` +
        `debug can include extra details and any internal notes.\n`;

      const promptTokens = estimateTokens(prompt);

      let raw = await generateTextWithOllamaRemote(prompt);
      let parsed = safeParseJson(raw) || extractJsonObject(raw);
      if (!parsed) {
        const retryPrompt =
          `${prompt}\n\n` +
          `IMPORTANT: Your entire response must be valid JSON. Output JSON only.`;
        raw = await generateTextWithOllamaRemote(retryPrompt);
        parsed = safeParseJson(raw) || extractJsonObject(raw);
      }

      if (parsed && Array.isArray(parsed.web) && parsed.web.length > 0) {
        const extraWeb = await runWebActions(parsed.web);
        if (extraWeb) {
          const prompt2 =
            `${prompt}\n\n` +
            `Additional web context (requested):\n${extraWeb}\n\n` +
            `IMPORTANT: Return updated JSON only.`;
          raw = await generateTextWithOllamaRemote(prompt2);
          parsed = safeParseJson(raw) || extractJsonObject(raw) || parsed;
          webContext = clampTextChars(`${webContext}\n\n${extraWeb}`, 26000);
        }
      }

      if (webContext) {
        const urls = extractUrlsFromText(text);
        const entry =
          `# Web memory (${new Date().toISOString()})\n` +
          `User: ${clampTextChars(text, 400)}\n\n` +
          (urls.length > 0 ? `URLs:\n${urls.slice(0, 5).map(u => `- ${u}`).join('\n')}\n\n` : '') +
          `Context:\n${clampTextChars(webContext, 3500)}`;
        prependWebMemoryEntry(entry);
      }

      const response = parsed?.response ? String(parsed.response) : String(raw || '');
      const thinking = parsed?.thinking ? String(parsed.thinking) : '';
      const debug = parsed?.debug ? String(parsed.debug) : '';

      const fileIntentFromModel = !!parsed?.fileIntent;
      const fileSubdirFromModel = String(parsed?.fileSubdir || 'private');
      const filePathFromModel = String(parsed?.filePath || '').trim();

      const allowFileCreation = wantsFile(text);
      const files = allowFileCreation && Array.isArray(parsed?.files) ? parsed.files : [];
      const createdFiles = [];
      for (const f of files) {
        try {
          const subdir = String(f?.subdir || 'private');
          const path = String(f?.path || '');
          const contents = typeof f?.contents === 'string' ? f.contents : '';
          const instruction = String(f?.instruction || f?.title || 'created from telegram');
          const allowOverwrite = !!f?.allowOverwrite;
          if (!path || !contents) continue;
          const created = createBrainProposalFromGenerated({
            subdir,
            path,
            instruction,
            contextQuery: String(parsed?.contextQuery || ''),
            generated: contents,
            allowOverwrite,
            autoApply: true,
            applyAllowOverwrite: allowOverwrite
          });
          createdFiles.push({ path: `${created.target.subdir}/${created.target.path}`, proposalId: created.proposalId, applied: created.applied });
        } catch {
          continue;
        }
      }

      if (createdFiles.length === 0 && allowFileCreation) {
        try {
          const rel = defaultGeneratedFilePathForRequest(text);
          const targetPath = `private/${rel}`;
          const doc = await generateDocumentContentsForFile(text, response, targetPath);
          const created = createBrainProposalFromGenerated({
            subdir: 'private',
            path: rel,
            instruction: `created from telegram request: ${text}`,
            contextQuery: String(parsed?.contextQuery || ''),
            generated: doc || response,
            allowOverwrite: false,
            autoApply: true,
            applyAllowOverwrite: false
          });
          createdFiles.push({ path: `${created.target.subdir}/${created.target.path}`, proposalId: created.proposalId, applied: created.applied });
        } catch {
          // ignore
        }
      }

      appendChatLog(msg.chat.id, { t: new Date().toISOString(), role: 'assistant', text: response });

      let userVisible = response;
      if (createdFiles.length > 0 && responseLooksLikeMetaAboutFile(userVisible)) {
        userVisible = 'Done. Created the requested document.';
      }
      if (createdFiles.length > 0) {
        const createdLines = createdFiles
          .slice(0, 5)
          .map(cf => `- ${cf.path} (proposal ${cf.proposalId}, applied: ${cf.applied})`)
          .join('\n');
        userVisible += `\n\nCreated files:\n${createdLines}`;
      }

      const responseTokens = estimateTokens(userVisible);
      if (isContextFooterEnabledForUser(msg.from.id)) {
        const limit = getModelContextLimit();
        userVisible += `\n\n[context] prompt_est_tokens=${promptTokens} response_est_tokens=${responseTokens} model_context_limit=${limit}`;
      }

      if (outputMode === 'full') {
        const extra = `\n\n[mode: full]\n\nThinking:\n${thinking || '(none)'}\n\nDebug:\n${debug || '(none)'}`;
        bot.sendMessage(msg.chat.id, clampMessage(`${userVisible}${extra}`));
      } else if (outputMode === 'thinking') {
        const extra = `\n\n[mode: thinking]\n\nThinking:\n${thinking || '(none)'}`;
        bot.sendMessage(msg.chat.id, clampMessage(`${userVisible}${extra}`));
      } else {
        bot.sendMessage(msg.chat.id, clampMessage(userVisible));
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
