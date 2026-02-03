import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, relative, extname, dirname } from 'path';
import { homedir } from 'os';
import crypto from 'crypto';

import { executeRemote, getConnectionStatus } from './ssh.js';

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

function getBrainRoot(syncRoot) {
  return join(syncRoot, 'artifacts', 'brain');
}

function getBrainPaths(syncRoot) {
  const brainRoot = getBrainRoot(syncRoot);
  const docsDir = join(brainRoot, 'docs');
  const proposalsDir = join(brainRoot, 'proposals');
  const indexPath = join(brainRoot, 'index.json');

  ensureDir(brainRoot);
  ensureDir(docsDir);
  ensureDir(proposalsDir);

  return { syncRoot, brainRoot, docsDir, proposalsDir, indexPath };
}

function defaultTextExtensions() {
  const raw = (process.env.BRAIN_TEXT_EXTS || '').trim();
  if (!raw) {
    return new Set([
      '.txt', '.md', '.json', '.jsonl', '.yaml', '.yml',
      '.js', '.jsx', '.ts', '.tsx',
      '.py', '.sh', '.ps1',
      '.html', '.css'
    ]);
  }
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => (s.startsWith('.') ? s.toLowerCase() : `.${s.toLowerCase()}`))
  );
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function loadIndex(indexPath) {
  if (!existsSync(indexPath)) {
    return { version: 1, updatedAt: null, docs: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') {
      return { version: 1, updatedAt: null, docs: {} };
    }
    if (!parsed.docs || typeof parsed.docs !== 'object') {
      parsed.docs = {};
    }
    return parsed;
  } catch {
    return { version: 1, updatedAt: null, docs: {} };
  }
}

function saveIndex(indexPath, index) {
  const next = { ...index, updatedAt: new Date().toISOString() };
  writeFileSync(indexPath, JSON.stringify(next, null, 2));
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

function readTextFileIfAllowed(absPath, maxBytes) {
  const stat = statSync(absPath);
  if (stat.size > maxBytes) return null;

  const buf = readFileSync(absPath);
  if (looksBinary(buf)) return null;

  return buf.toString('utf-8');
}

function walkFiles(rootDir) {
  const files = [];
  if (!existsSync(rootDir)) return files;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function getBrainStatus() {
  const syncRoot = getSyncRoot();
  const { brainRoot, proposalsDir, indexPath } = getBrainPaths(syncRoot);
  const index = loadIndex(indexPath);
  const proposalCount = existsSync(proposalsDir) ? readdirSync(proposalsDir).filter(f => f.endsWith('.json')).length : 0;
  const docCount = Object.keys(index.docs || {}).length;

  return {
    syncRoot,
    brainRoot,
    indexedDocs: docCount,
    proposals: proposalCount,
    updatedAt: index.updatedAt
  };
}

export function indexBrain(options = {}) {
  const {
    include = ['public', 'private', 'artifacts'],
    maxFileBytes = parseInt(process.env.BRAIN_MAX_FILE_BYTES || '524288'),
    maxDocChars = parseInt(process.env.BRAIN_MAX_DOC_CHARS || '20000')
  } = options;

  const syncRoot = getSyncRoot();
  const { docsDir, indexPath } = getBrainPaths(syncRoot);
  const index = loadIndex(indexPath);
  const exts = defaultTextExtensions();

  const stats = {
    scanned: 0,
    updated: 0,
    skippedBinary: 0,
    skippedTooLarge: 0,
    skippedUnchanged: 0,
    errors: 0
  };

  for (const subdir of include) {
    const dir = join(syncRoot, subdir);
    const absFiles = walkFiles(dir);

    for (const absPath of absFiles) {
      stats.scanned += 1;

      try {
        const relPath = relative(dir, absPath).replace(/\\/g, '/');
        if (subdir === 'artifacts' && relPath.toLowerCase().startsWith('brain/')) {
          stats.skippedUnchanged += 1;
          continue;
        }
        const docKey = `${subdir}/${relPath}`;
        const ext = extname(absPath).toLowerCase();
        const fileStat = statSync(absPath);

        if (fileStat.size > maxFileBytes) {
          stats.skippedTooLarge += 1;
          continue;
        }

        if (exts.size > 0 && !exts.has(ext)) {
          const buf = readFileSync(absPath);
          if (looksBinary(buf)) {
            stats.skippedBinary += 1;
            continue;
          }
        }

        const content = readTextFileIfAllowed(absPath, maxFileBytes);
        if (content === null) {
          stats.skippedBinary += 1;
          continue;
        }

        const truncated = content.length > maxDocChars ? content.slice(0, maxDocChars) : content;
        const contentHash = sha256(truncated);

        const existing = index.docs[docKey];
        if (existing && existing.sha256 === contentHash && Math.abs(existing.mtime - fileStat.mtimeMs) < 1) {
          stats.skippedUnchanged += 1;
          continue;
        }

        const docId = sha256(docKey).slice(0, 16);
        const docPath = join(docsDir, `${docId}.txt`);
        writeFileSync(docPath, truncated);

        index.docs[docKey] = {
          id: docId,
          sha256: contentHash,
          size: fileStat.size,
          mtime: fileStat.mtimeMs,
          storedAt: Date.now(),
          contentPath: `docs/${docId}.txt`
        };

        stats.updated += 1;
      } catch {
        stats.errors += 1;
      }
    }
  }

  saveIndex(indexPath, index);
  return { ...stats, indexedDocs: Object.keys(index.docs).length };
}

function tokenizeQuery(query) {
  return (query || '')
    .toLowerCase()
    .split(/[^a-z0-9_\-./]+/g)
    .map(s => s.trim())
    .filter(s => s.length > 1);
}

function scoreText(text, terms) {
  if (!text) return 0;
  const hay = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let idx = 0;
    while (true) {
      const next = hay.indexOf(term, idx);
      if (next === -1) break;
      score += 1;
      idx = next + term.length;
      if (score > 2000) break;
    }
  }
  return score;
}

function makeSnippet(text, terms, maxLen = 500) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let first = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (first === -1 || i < first)) first = i;
  }
  if (first === -1) {
    return text.slice(0, maxLen);
  }
  const start = Math.max(0, first - Math.floor(maxLen / 3));
  const end = Math.min(text.length, start + maxLen);
  return text.slice(start, end);
}

export function queryBrain(query, options = {}) {
  const { limit = 10, maxReadChars = parseInt(process.env.BRAIN_QUERY_READ_CHARS || '20000') } = options;

  const syncRoot = getSyncRoot();
  const { brainRoot, indexPath } = getBrainPaths(syncRoot);
  const index = loadIndex(indexPath);
  const terms = tokenizeQuery(query);
  if (terms.length === 0) {
    return { query, results: [] };
  }

  const results = [];

  for (const [docKey, meta] of Object.entries(index.docs || {})) {
    try {
      const docAbsPath = join(brainRoot, meta.contentPath);
      if (!existsSync(docAbsPath)) continue;
      const content = readFileSync(docAbsPath, 'utf-8');
      const clipped = content.length > maxReadChars ? content.slice(0, maxReadChars) : content;
      const score = scoreText(clipped, terms) + (scoreText(docKey, terms) * 3);
      if (score <= 0) continue;

      const preview = makeSnippet(clipped, terms, 500);
      results.push({ docKey, score, preview });
    } catch {
      continue;
    }
  }

  results.sort((a, b) => b.score - a.score);
  return { query, results: results.slice(0, limit) };
}

export function listBrainProposals() {
  const syncRoot = getSyncRoot();
  const { proposalsDir } = getBrainPaths(syncRoot);
  if (!existsSync(proposalsDir)) return [];

  const files = readdirSync(proposalsDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const proposals = [];
  for (const file of files) {
    try {
      const abs = join(proposalsDir, file);
      const parsed = JSON.parse(readFileSync(abs, 'utf-8'));
      proposals.push(parsed);
    } catch {
      continue;
    }
  }

  return proposals;
}

function sanitizeFilename(name) {
  return (name || 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 120);
}

function resolveTargetPath(syncRoot, subdir, relPath) {
  const cleanSubdir = (subdir || '').trim();
  if (!['public', 'private', 'artifacts'].includes(cleanSubdir)) {
    throw new Error('Invalid subdir. Must be one of: public, private, artifacts');
  }

  const safeRel = (relPath || '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!safeRel || safeRel.includes('..')) {
    throw new Error('Invalid target path');
  }

  const absPath = join(syncRoot, cleanSubdir, safeRel);
  return { cleanSubdir, safeRel, absPath };
}

function createProposalRecord(syncRoot, proposal) {
  const { proposalsDir } = getBrainPaths(syncRoot);
  const id = proposal.id;
  const fname = `${proposal.createdAt.replace(/[:.]/g, '-')}_${sanitizeFilename(id)}.json`;
  const abs = join(proposalsDir, fname);
  writeFileSync(abs, JSON.stringify(proposal, null, 2));
  return { id, file: fname };
}

export function createBrainProposalFromGenerated(options = {}) {
  const {
    subdir = 'private',
    path,
    instruction = '',
    contextQuery = '',
    generated,
    allowOverwrite = false,
    autoApply = false,
    applyAllowOverwrite = false
  } = options;

  if (!path) throw new Error('Missing path');
  if (typeof generated !== 'string') throw new Error('Missing generated');

  const syncRoot = getSyncRoot();
  const { absPath, safeRel, cleanSubdir } = resolveTargetPath(syncRoot, subdir, path);

  if (!allowOverwrite && existsSync(absPath)) {
    throw new Error(`Target already exists: ${cleanSubdir}/${safeRel}`);
  }

  const proposalId = sha256(`${cleanSubdir}/${safeRel}:${Date.now()}:${instruction || 'generated'}`).slice(0, 16);
  const proposal = {
    id: proposalId,
    createdAt: new Date().toISOString(),
    target: { subdir: cleanSubdir, path: safeRel },
    allowOverwrite: !!allowOverwrite,
    instruction,
    contextQuery,
    generated
  };

  const stored = createProposalRecord(syncRoot, proposal);

  let appliedResult = null;
  if (autoApply) {
    appliedResult = applyBrainProposal({ proposalId: stored.id, allowOverwrite: !!(applyAllowOverwrite || allowOverwrite) });
  }

  return {
    proposalId: stored.id,
    proposalFile: stored.file,
    target: proposal.target,
    applied: !!appliedResult?.applied
  };
}

async function generateWithOllamaRemote(prompt) {
  const { connected } = getConnectionStatus();
  if (!connected) {
    throw new Error('Not connected. Run connect first.');
  }

  const model = (await executeRemote('cat ~/.openclaw/current_model 2>/dev/null || echo ""', { quiet: true })).trim();
  if (!model) {
    throw new Error('No remote model selected. Try running connect again.');
  }

  const promptB64 = Buffer.from(prompt, 'utf-8').toString('base64');
  const safeModel = model.replace(/"/g, '');
  const cmd =
    `MODEL="${safeModel}" PROMPT_B64="${promptB64}" node -e ` +
    `"` +
    `const model=process.env.MODEL;` +
    `const prompt=Buffer.from(process.env.PROMPT_B64||'', 'base64').toString('utf8');` +
    `fetch('http://127.0.0.1:11434/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,prompt,stream:false})})` +
    `.then(r=>r.json())` +
    `.then(j=>process.stdout.write((j&&j.response)?j.response:''))` +
    `.catch(e=>{process.stderr.write(e.message||String(e));process.exit(2);});` +
    `"`;

  const out = await executeRemote(cmd, { quiet: true });
  return out;
}

export async function generateTextWithOllamaRemote(prompt) {
  return generateWithOllamaRemote(prompt);
}

export async function createBrainProposal(options = {}) {
  const {
    subdir = 'private',
    path,
    instruction,
    contextQuery = '',
    allowOverwrite = false,
    autoIndex = true
  } = options;

  if (!path) throw new Error('Missing path');
  if (!instruction) throw new Error('Missing instruction');

  const syncRoot = getSyncRoot();
  const { absPath, safeRel, cleanSubdir } = resolveTargetPath(syncRoot, subdir, path);

  if (!allowOverwrite && existsSync(absPath)) {
    throw new Error(`Target already exists: ${cleanSubdir}/${safeRel}`);
  }

  if (autoIndex) {
    indexBrain();
  }

  const context = contextQuery ? queryBrain(contextQuery, { limit: 6 }) : { results: [] };
  const blocks = (context.results || [])
    .slice(0, 6)
    .map(r => `FILE: ${r.docKey}\n${r.preview}`)
    .join('\n\n');

  const prompt =
    `You are generating the full contents of a single file.\n` +
    `Return only the file contents. Do not wrap in code fences.\n\n` +
    `Target path: ${cleanSubdir}/${safeRel}\n` +
    `Instruction: ${instruction}\n\n` +
    (blocks ? `Context:\n${blocks}\n\n` : '') +
    `Now output the file contents.`;

  const generated = await generateWithOllamaRemote(prompt);

  const proposalId = sha256(`${cleanSubdir}/${safeRel}:${Date.now()}:${instruction}`).slice(0, 16);
  const proposal = {
    id: proposalId,
    createdAt: new Date().toISOString(),
    target: { subdir: cleanSubdir, path: safeRel },
    allowOverwrite: !!allowOverwrite,
    instruction,
    contextQuery,
    generated
  };

  const stored = createProposalRecord(syncRoot, proposal);
  return { proposalId: stored.id, proposalFile: stored.file, target: proposal.target };
}

export function applyBrainProposal(options = {}) {
  const { proposalId, allowOverwrite = false } = options;
  if (!proposalId) throw new Error('Missing proposalId');

  const syncRoot = getSyncRoot();
  const { proposalsDir } = getBrainPaths(syncRoot);

  const files = readdirSync(proposalsDir).filter(f => f.endsWith('.json'));
  let proposalFile = null;
  for (const f of files) {
    try {
      const abs = join(proposalsDir, f);
      const parsed = JSON.parse(readFileSync(abs, 'utf-8'));
      if (parsed && parsed.id === proposalId) {
        proposalFile = f;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!proposalFile) {
    throw new Error(`Proposal not found: ${proposalId}`);
  }

  const proposalAbs = join(proposalsDir, proposalFile);
  const proposal = JSON.parse(readFileSync(proposalAbs, 'utf-8'));

  const { absPath } = resolveTargetPath(syncRoot, proposal.target?.subdir, proposal.target?.path);

  if (!allowOverwrite && existsSync(absPath)) {
    throw new Error(`Target already exists: ${proposal.target.subdir}/${proposal.target.path}`);
  }

  ensureDir(dirname(absPath));
  writeFileSync(absPath, proposal.generated || '');

  proposal.appliedAt = new Date().toISOString();
  writeFileSync(proposalAbs, JSON.stringify(proposal, null, 2));

  return { applied: true, target: proposal.target };
}
