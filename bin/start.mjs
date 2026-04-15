#!/usr/bin/env node
process.title = 'ccbuddy';
import { appendFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const dataDir = join(ROOT, 'data');
mkdirSync(dataDir, { recursive: true });
const LOG = join(dataDir, 'ccbuddy.log');
const log = (msg) => appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);

// Ensure better-sqlite3 native module matches this Node.js ABI
try {
  await import('better-sqlite3');
} catch (err) {
  if (err?.message?.includes('NODE_MODULE_VERSION')) {
    log('Native module mismatch — rebuilding better-sqlite3...');
    execSync('npm rebuild better-sqlite3', { cwd: ROOT, stdio: 'ignore' });
    log('Rebuild complete');
  } else {
    throw err;
  }
}

const origLog = console.log;
const origErr = console.error;
console.log = (...a) => { log(a.join(' ')); origLog(...a); };
console.error = (...a) => { log('ERR: ' + a.join(' ')); origErr(...a); };
process.on('unhandledRejection', (err) => { log('UNHANDLED: ' + (err?.stack || err)); });
process.on('uncaughtException', (err) => {
  const msg = err?.stack || String(err);
  const line = `[${new Date().toISOString()}] UNCAUGHT EXCEPTION: ${msg}\n`;
  try { appendFileSync(LOG, line); } catch {}
  console.error(line);
  process.exit(1);
});

log('Starting CCBuddy...');
const { bootstrap } = await import('../packages/main/dist/bootstrap.js');
const result = await bootstrap(
  join(ROOT, 'config'),
);
log('CCBuddy running');

process.on('SIGTERM', async () => { log('SIGTERM received'); await result.stop(); process.exit(0); });
process.on('SIGINT', async () => { log('SIGINT received'); await result.stop(); process.exit(0); });
// SIGUSR1 = restart request: graceful stop then non-zero exit so launchd restarts us
process.on('SIGUSR1', async () => { log('SIGUSR1 received — restart requested'); await result.stop(); process.exit(2); });
