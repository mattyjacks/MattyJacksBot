#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { connect, getConnectionStatus } from './ssh.js';
import { runSync, getSyncStatus } from './sync.js';
import { getAgentStatus, startAgent, stopAgent } from './agent.js';
import { tailLogs } from './logs.js';
import { getBrainStatus, indexBrain, queryBrain, listBrainProposals, createBrainProposal, applyBrainProposal } from './brain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

const program = new Command();

program
  .name('v1')
  .description('Moltbook + OpenClaw control system')
  .version('1.0.0');

program
  .command('connect')
  .description('Connect to Vast.ai instance and bootstrap OpenClaw')
  .option('-f, --force', 'Force reinstall even if already set up')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options) => {
    console.log(chalk.blue.bold('\n🦞 Connecting to Vast.ai instance...\n'));
    
    try {
      await connect({
        force: options.force,
        verbose: options.verbose
      });
      console.log(chalk.green.bold('\n✓ Successfully connected and bootstrapped!\n'));
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Connection failed:'), error.message);
      process.exit(1);
    }
  });

program
  .command('sync')
  .description('Run bidirectional sync between PC and Vast.ai')
  .option('-d, --dry-run', 'Show what would be synced without making changes')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (options) => {
    console.log(chalk.blue.bold('\n🔄 Running bidirectional sync...\n'));
    
    try {
      const result = await runSync({
        dryRun: options.dryRun,
        verbose: options.verbose
      });
      
      console.log(chalk.green(`  ↑ Uploaded: ${result.uploaded} files`));
      console.log(chalk.cyan(`  ↓ Downloaded: ${result.downloaded} files`));
      
      if (result.conflicts.length > 0) {
        console.log(chalk.yellow(`  ⚠ Conflicts resolved: ${result.conflicts.length}`));
      }
      
      console.log(chalk.green.bold('\n✓ Sync complete!\n'));
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Sync failed:'), error.message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current status of agent, sync, and connections')
  .action(async () => {
    console.log(chalk.blue.bold('\n📊 Status\n'));
    
    try {
      const connStatus = await getConnectionStatus();
      const syncStatus = await getSyncStatus();
      const agentStatus = await getAgentStatus();
      
      console.log(chalk.white.bold('Connection:'));
      console.log(`  Host: ${connStatus.host || 'Not configured'}`);
      console.log(`  Status: ${connStatus.connected ? chalk.green('Connected') : chalk.red('Disconnected')}`);
      
      console.log(chalk.white.bold('\nSync:'));
      console.log(`  Last sync: ${syncStatus.lastSync || 'Never'}`);
      console.log(`  Public files: ${syncStatus.publicFiles}`);
      console.log(`  Private files: ${syncStatus.privateFiles}`);
      console.log(`  Artifacts: ${syncStatus.artifactFiles}`);
      
      console.log(chalk.white.bold('\nAgent:'));
      console.log(`  Status: ${agentStatus.running ? chalk.green('Running') : chalk.yellow('Stopped')}`);
      console.log(`  Model: ${agentStatus.model || 'Not loaded'}`);
      console.log(`  VRAM: ${agentStatus.vram || 'Unknown'}`);
      console.log(`  Moltbook mode: ${agentStatus.moltbookMode || 'readonly'}`);
      
      console.log('');
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Status check failed:'), error.message);
      process.exit(1);
    }
  });

program
  .command('logs')
  .description('Tail logs from the remote agent')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .option('-f, --follow', 'Follow log output')
  .action(async (options) => {
    try {
      await tailLogs({
        lines: parseInt(options.lines),
        follow: options.follow
      });
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Failed to get logs:'), error.message);
      process.exit(1);
    }
  });

const agentCmd = program
  .command('agent')
  .description('Control the OpenClaw agent');

agentCmd
  .command('start')
  .description('Start the OpenClaw agent')
  .action(async () => {
    console.log(chalk.blue.bold('\n🚀 Starting agent...\n'));
    
    try {
      await startAgent();
      console.log(chalk.green.bold('✓ Agent started!\n'));
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Failed to start agent:'), error.message);
      process.exit(1);
    }
  });

agentCmd
  .command('stop')
  .description('Stop the OpenClaw agent')
  .action(async () => {
    console.log(chalk.blue.bold('\n🛑 Stopping agent...\n'));
    
    try {
      await stopAgent();
      console.log(chalk.green.bold('✓ Agent stopped!\n'));
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Failed to stop agent:'), error.message);
      process.exit(1);
    }
  });

const moltbookCmd = program
  .command('moltbook')
  .description('Moltbook integration controls');

moltbookCmd
  .command('mode <mode>')
  .description('Set Moltbook mode: readonly, approval, or autonomous')
  .action(async (mode) => {
    const validModes = ['readonly', 'approval', 'autonomous'];
    if (!validModes.includes(mode)) {
      console.error(chalk.red(`Invalid mode. Must be one of: ${validModes.join(', ')}`));
      process.exit(1);
    }
    
    console.log(chalk.blue(`Setting Moltbook mode to: ${mode}`));
    // Implementation in agent.js
  });

moltbookCmd
  .command('approve <postId>')
  .description('Approve a pending Moltbook post')
  .action(async (postId) => {
    console.log(chalk.blue(`Approving post: ${postId}`));
    // Implementation in agent.js
  });

moltbookCmd
  .command('pending')
  .description('List pending Moltbook posts awaiting approval')
  .action(async () => {
    console.log(chalk.blue('Pending posts:'));
    // Implementation in agent.js
  });

const brainCmd = program
  .command('brain')
  .description('Local brain: index synced files, query context, and create/apply file proposals');

brainCmd
  .command('status')
  .description('Show brain index status and proposal count')
  .action(async () => {
    try {
      const s = getBrainStatus();
      console.log(chalk.blue.bold('\n🧠 Brain Status\n'));
      console.log(`  Sync root: ${s.syncRoot}`);
      console.log(`  Brain root: ${s.brainRoot}`);
      console.log(`  Indexed docs: ${s.indexedDocs}`);
      console.log(`  Proposals: ${s.proposals}`);
      console.log(`  Updated: ${s.updatedAt || 'Never'}`);
      console.log('');
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Brain status failed:'), error.message);
      process.exit(1);
    }
  });

brainCmd
  .command('index')
  .description('Index files from the sync folders into brain context')
  .option('-i, --include <list>', 'Comma-separated list: public,private,artifacts', 'public,private,artifacts')
  .action(async (options) => {
    try {
      const include = options.include
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      console.log(chalk.blue.bold('\n🧠 Indexing brain...\n'));
      const result = indexBrain({ include });
      console.log(chalk.green(`  Updated: ${result.updated}`));
      console.log(chalk.cyan(`  Scanned: ${result.scanned}`));
      console.log(chalk.white(`  Indexed docs: ${result.indexedDocs}`));
      console.log('');
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Brain index failed:'), error.message);
      process.exit(1);
    }
  });

brainCmd
  .command('query <q>')
  .description('Search brain context')
  .option('-l, --limit <n>', 'Max results', '10')
  .action(async (q, options) => {
    try {
      const limit = parseInt(options.limit);
      const out = queryBrain(q, { limit });
      console.log(chalk.blue.bold(`\n🧠 Query: ${out.query}\n`));
      for (const r of out.results) {
        console.log(chalk.white.bold(`- ${r.docKey} (${r.score})`));
        console.log(chalk.gray(r.preview.replace(/\n/g, '\n  ')));
        console.log('');
      }
      if (!out.results || out.results.length === 0) {
        console.log(chalk.yellow('No matches.'));
      }
      console.log('');
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Brain query failed:'), error.message);
      process.exit(1);
    }
  });

brainCmd
  .command('proposals')
  .description('List brain file proposals')
  .action(async () => {
    try {
      const proposals = listBrainProposals();
      console.log(chalk.blue.bold(`\n🧠 Proposals (${proposals.length})\n`));
      for (const p of proposals) {
        const applied = p.appliedAt ? chalk.green('applied') : chalk.yellow('pending');
        console.log(`${p.id}  ${applied}  ${p.target?.subdir}/${p.target?.path}  ${p.createdAt}`);
      }
      console.log('');
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Listing proposals failed:'), error.message);
      process.exit(1);
    }
  });

brainCmd
  .command('propose')
  .description('Create a proposal for a new file (generated on Vast with Ollama)')
  .requiredOption('-p, --path <path>', 'Target path relative to subdir')
  .requiredOption('-n, --instruction <text>', 'Instruction for the file content')
  .option('-s, --subdir <name>', 'Target subdir: public,private,artifacts', 'private')
  .option('-c, --context <q>', 'Context query for retrieval', '')
  .option('--overwrite', 'Allow overwriting target file (danger)', false)
  .option('--no-auto-index', 'Do not run index before proposing')
  .action(async (options) => {
    try {
      console.log(chalk.blue.bold('\n🧠 Creating proposal...\n'));
      const result = await createBrainProposal({
        subdir: options.subdir,
        path: options.path,
        instruction: options.instruction,
        contextQuery: options.context,
        allowOverwrite: !!options.overwrite,
        autoIndex: !!options.autoIndex
      });
      console.log(chalk.green(`✓ Proposal created: ${result.proposalId}`));
      console.log(chalk.white(`  File: artifacts/brain/proposals/${result.proposalFile}`));
      console.log(chalk.white(`  Target: ${result.target.subdir}/${result.target.path}`));
      console.log('');
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Proposal failed:'), error.message);
      process.exit(1);
    }
  });

brainCmd
  .command('apply <proposalId>')
  .description('Apply a proposal to create the target file locally (writes into sync folders)')
  .option('--overwrite', 'Allow overwriting existing target file (danger)', false)
  .action(async (proposalId, options) => {
    try {
      const result = applyBrainProposal({ proposalId, allowOverwrite: !!options.overwrite });
      console.log(chalk.green(`\n✓ Applied to: ${result.target.subdir}/${result.target.path}\n`));
    } catch (error) {
      console.error(chalk.red.bold('\n✗ Apply failed:'), error.message);
      process.exit(1);
    }
  });

program.parse();
