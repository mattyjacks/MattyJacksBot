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

program.parse();
