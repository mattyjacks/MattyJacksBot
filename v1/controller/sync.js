import { executeRemote } from './ssh.js';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, relative } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const SYNC_STATE_FILE = 'sync_state.json';

function getSyncRoot() {
  const configuredRoot = process.env.SYNC_ROOT;
  if (configuredRoot) {
    return configuredRoot.replace('%USERPROFILE%', homedir());
  }
  return join(homedir(), 'Documents', 'mattyjacksbot', 'v1');
}

function ensureLocalDirectories() {
  const root = getSyncRoot();
  const dirs = ['public', 'private', 'artifacts', 'state', '.sync_backups'];
  
  for (const dir of dirs) {
    const path = join(root, dir);
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
  }
  
  return root;
}

function loadSyncState(root) {
  const statePath = join(root, 'state', SYNC_STATE_FILE);
  if (existsSync(statePath)) {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  }
  return {
    lastSync: null,
    files: {}
  };
}

function saveSyncState(root, state) {
  const statePath = join(root, 'state', SYNC_STATE_FILE);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function getLocalFiles(root, subdir) {
  const dir = join(root, subdir);
  const files = {};
  
  if (!existsSync(dir)) return files;
  
  function walk(currentDir) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      const relativePath = relative(dir, fullPath);
      
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const stat = statSync(fullPath);
        files[relativePath] = {
          path: relativePath,
          size: stat.size,
          mtime: stat.mtimeMs
        };
      }
    }
  }
  
  walk(dir);
  return files;
}

async function getRemoteFiles(subdir) {
  const remoteRoot = '~/mattyjacksbot/v1/sync';
  
  try {
    const result = await executeRemote(
      `find ${remoteRoot}/${subdir} -type f -exec stat --format='%n|%s|%Y' {} \\; 2>/dev/null || true`,
      { quiet: true }
    );
    
    const files = {};
    const lines = result.trim().split('\n').filter(l => l);
    
    for (const line of lines) {
      const [fullPath, size, mtime] = line.split('|');
      const relativePath = fullPath.replace(`${remoteRoot}/${subdir}/`, '').replace(/^~\/mattyjacksbot\/v1\/sync\/[^/]+\//, '');
      
      if (relativePath && size) {
        files[relativePath] = {
          path: relativePath,
          size: parseInt(size),
          mtime: parseInt(mtime) * 1000
        };
      }
    }
    
    return files;
  } catch {
    return {};
  }
}

function backupFile(root, subdir, relativePath) {
  const backupDir = process.env.SYNC_BACKUP_DIR || '.sync_backups';
  const sourcePath = join(root, subdir, relativePath);
  const timestamp = Date.now();
  const backupPath = join(root, backupDir, `${subdir}_${relativePath.replace(/[/\\]/g, '_')}_${timestamp}`);
  
  if (existsSync(sourcePath)) {
    const backupDirPath = join(root, backupDir);
    if (!existsSync(backupDirPath)) {
      mkdirSync(backupDirPath, { recursive: true });
    }
    copyFileSync(sourcePath, backupPath);
  }
}

function resolveConflict(localFile, remoteFile) {
  const policy = process.env.SYNC_CONFLICT_POLICY || 'newest';
  
  switch (policy) {
    case 'pc_wins':
      return 'upload';
    case 'vast_wins':
      return 'download';
    case 'keep_both':
      return 'both';
    case 'newest':
    default:
      return localFile.mtime > remoteFile.mtime ? 'upload' : 'download';
  }
}

export async function runSync(options = {}) {
  const { dryRun = false, verbose = false } = options;
  
  const root = ensureLocalDirectories();
  const state = loadSyncState(root);
  
  const result = {
    uploaded: 0,
    downloaded: 0,
    conflicts: [],
    errors: []
  };
  
  const subdirs = ['public', 'private', 'artifacts'];
  
  for (const subdir of subdirs) {
    const localFiles = getLocalFiles(root, subdir);
    const remoteFiles = await getRemoteFiles(subdir);
    
    const allPaths = new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)]);
    
    for (const path of allPaths) {
      const local = localFiles[path];
      const remote = remoteFiles[path];
      
      try {
        if (local && !remote) {
          if (verbose) console.log(`  ↑ ${subdir}/${path}`);
          if (!dryRun) {
            await uploadFile(root, subdir, path);
          }
          result.uploaded++;
        } else if (!local && remote) {
          if (verbose) console.log(`  ↓ ${subdir}/${path}`);
          if (!dryRun) {
            await downloadFile(root, subdir, path);
          }
          result.downloaded++;
        } else if (local && remote) {
          if (local.size !== remote.size || Math.abs(local.mtime - remote.mtime) > 1000) {
            const resolution = resolveConflict(local, remote);
            result.conflicts.push({ path: `${subdir}/${path}`, resolution });
            
            if (verbose) {
              console.log(`  ⚠ Conflict: ${subdir}/${path} -> ${resolution}`);
            }
            
            if (!dryRun) {
              backupFile(root, subdir, path);
              
              if (resolution === 'upload' || resolution === 'both') {
                await uploadFile(root, subdir, path);
                result.uploaded++;
              }
              if (resolution === 'download' || resolution === 'both') {
                if (resolution === 'both') {
                  const conflictPath = path.replace(/(\.[^.]+)$/, `.sync-conflict-local$1`);
                  copyFileSync(
                    join(root, subdir, path),
                    join(root, subdir, conflictPath)
                  );
                }
                await downloadFile(root, subdir, path);
                result.downloaded++;
              }
            }
          }
        }
      } catch (error) {
        result.errors.push({ path: `${subdir}/${path}`, error: error.message });
        if (verbose) {
          console.log(`  ✗ Error: ${subdir}/${path}: ${error.message}`);
        }
      }
    }
  }
  
  if (!dryRun) {
    state.lastSync = new Date().toISOString();
    saveSyncState(root, state);
  }
  
  return result;
}

async function uploadFile(root, subdir, relativePath) {
  const localPath = join(root, subdir, relativePath);
  const remotePath = `~/mattyjacksbot/v1/sync/${subdir}/${relativePath}`;
  const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
  
  await executeRemote(`mkdir -p ${remoteDir}`, { quiet: true });
  
  const content = readFileSync(localPath);
  const base64 = content.toString('base64');
  
  await executeRemote(
    `echo "${base64}" | base64 -d > "${remotePath}"`,
    { quiet: true }
  );
}

async function downloadFile(root, subdir, relativePath) {
  const localPath = join(root, subdir, relativePath);
  const remotePath = `~/mattyjacksbot/v1/sync/${subdir}/${relativePath}`;
  
  const localDir = localPath.substring(0, localPath.lastIndexOf('\\'));
  if (!existsSync(localDir)) {
    mkdirSync(localDir, { recursive: true });
  }
  
  const base64 = await executeRemote(
    `base64 "${remotePath}"`,
    { quiet: true }
  );
  
  const content = Buffer.from(base64.trim(), 'base64');
  writeFileSync(localPath, content);
}

export async function getSyncStatus() {
  const root = getSyncRoot();
  ensureLocalDirectories();
  
  const state = loadSyncState(root);
  
  const countFiles = (dir) => {
    try {
      return Object.keys(getLocalFiles(root, dir)).length;
    } catch {
      return 0;
    }
  };
  
  return {
    lastSync: state.lastSync,
    publicFiles: countFiles('public'),
    privateFiles: countFiles('private'),
    artifactFiles: countFiles('artifacts'),
    syncRoot: root
  };
}
