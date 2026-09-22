#!/usr/bin/env node
// Runs the backend (port 3000) and frontend (port 3001) together.
// On Ctrl+C, stops both process trees and force-frees their ports so
// reruns never hit "address already in use".
//
// Node rather than a shell script so one command works in PowerShell, cmd and
// bash alike: Windows has no `bash` on PATH by default, and no `lsof` at all.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

// Each server is started from its real JS entry point instead of through
// `npm run`. On Windows the npm wrapper is a .cmd batch file, which hides
// Ctrl+C behind a "Terminate batch job (Y/N)?" prompt and leaves the watcher
// and dev-server children running as orphans holding the port.
const SERVERS = [
  {
    name: 'backend',
    port: 3000,
    cwd: join(ROOT_DIR, 'backend'),
    args: [join(ROOT_DIR, 'backend', 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js'), 'start', '--watch'],
  },
  {
    name: 'frontend',
    port: 3001,
    cwd: join(ROOT_DIR, 'frontend'),
    args: [join(ROOT_DIR, 'frontend', 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', '3001'],
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidsOnPort(port) {
  if (IS_WINDOWS) {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout ?? '';
    const pids = out.split(/\r?\n/).flatMap((line) => {
      const [, local, , state, pid] = line.trim().split(/\s+/);
      return state === 'LISTENING' && local?.endsWith(`:${port}`) && pid ? [Number(pid)] : [];
    });
    return [...new Set(pids)];
  }
  const out = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).stdout ?? '';
  return out.split(/\s+/).filter(Boolean).map(Number);
}

// Signals the whole tree, not just the top process: nest spawns a TypeScript
// compiler and next spawns a render worker, and either one alone keeps the
// port bound. On POSIX the negative pid reaches the child's process group;
// Windows has no process groups to signal, so `taskkill /T` walks the tree
// instead and can only end it outright.
function signalTree(pid, signal) {
  if (IS_WINDOWS) {
    if (signal === 'SIGTERM') return;
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone, or never got its own process group.
  }
}

// Retries because a process that was still starting up at the moment of the
// kill may bind to its port a moment later, after the kill already ran.
async function freePort(port) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pids = pidsOnPort(port);
    if (pids.length === 0) return;
    for (const pid of pids) signalTree(pid, 'SIGKILL');
    await sleep(1000);
  }
}

const children = [];
let shuttingDown = false;

const isRunning = (child) =>
  child.pid !== undefined && child.exitCode === null && child.signalCode === null;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping dev servers...');
  for (const child of children) {
    if (isRunning(child)) signalTree(child.pid, 'SIGTERM');
  }
  // Give a graceful exit a moment before forcing it. Skipped on Windows,
  // where the SIGTERM pass above is a no-op.
  if (!IS_WINDOWS) await sleep(1000);
  for (const child of children) {
    if (isRunning(child)) signalTree(child.pid, 'SIGKILL');
  }
  await Promise.all(SERVERS.map((server) => freePort(server.port)));
  process.exit(code);
}

// SIGBREAK and SIGHUP are Ctrl+Break and a closed terminal window; names that
// do not exist on the current platform are inert.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(signal, () => void shutdown(0));
}

await Promise.all(SERVERS.map((server) => freePort(server.port)));

for (const server of SERVERS) {
  const child = spawn(process.execPath, server.args, {
    cwd: server.cwd,
    stdio: 'inherit',
    // POSIX: give the child its own process group, so a negative-pid kill
    // takes the whole tree and Ctrl+C reaches this script rather than being
    // delivered straight to the servers. Windows: keep it on this console,
    // where the tree is reached with `taskkill /T`.
    detached: !IS_WINDOWS,
  });
  child.on('exit', (code) => void shutdown(code ?? 0));
  child.on('error', (error) => {
    console.error(`Failed to start ${server.name}: ${error.message}`);
    void shutdown(1);
  });
  children.push(child);
}
