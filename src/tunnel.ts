import { spawn, type ChildProcess } from 'node:child_process';
import { stat, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { devNull } from 'node:os';
import type { TunnelConfig } from './config.js';

export type TunnelState = 'starting' | 'spawned' | 'connection-ready' | 'stopped' | 'failed';
export interface TunnelStatus { state: TunnelState; publicReachabilityVerified: false }
export interface Tunnel { status(): TunnelStatus; close(): Promise<void> }
export type TunnelStarter = (config: TunnelConfig) => Promise<Tunnel>;
export type SpawnTunnel = (command: string, args: string[]) => ChildProcess;
/** Only this returned child is owned. Existing cloudflared processes are never discovered or stopped. */
export async function startTunnel(config: TunnelConfig, spawnChild: SpawnTunnel = (command, args) => spawn(command, args, {
  shell: false, stdio: ['ignore', 'ignore', 'pipe'],
  // Do not let an unrelated inherited token, config or debug/log setting override this mapping.
  env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('TUNNEL_') && !['NO_AUTOUPDATE', 'NO_TLS_VERIFY'].includes(name))),
})): Promise<Tunnel> {
  const args = ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', '--loglevel', 'info'];
  try {
    if ((config.tokenFile === undefined) === (config.configFile === undefined)) throw new Error();
    if (config.tokenFile !== undefined) {
      const file = config.tokenFile;
      const info = await lstat(file), parent = await lstat(path.dirname(file));
      if (!path.isAbsolute(file) || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 16384
        || !parent.isDirectory() || parent.isSymbolicLink() || await realpath(file) !== file
        || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0 || info.uid !== process.geteuid!()))) throw new Error();
      // cloudflared reads the secret directly. No token bytes enter model context, argv or logs.
      // An explicit empty config prevents unrelated default ~/.cloudflared config inheritance.
      args.push('--config', devNull, 'run', '--token-file', file);
    } else {
      if (!(await stat(config.configFile!)).isFile()) throw new Error();
      args.push('--config', config.configFile!, 'run');
    }
  } catch { throw new Error('Tunnel configuration or protected token file is unavailable'); }
  let child: ChildProcess;
  try { child = spawnChild('cloudflared', args); }
  catch { throw new Error('Tunnel process could not start'); }
  let state: TunnelState = 'starting', ended = false, closing = false;
  let finish!: () => void;
  const exited = new Promise<void>(resolve => { finish = resolve; });
  const onExit = () => { ended = true; state = closing ? 'stopped' : 'failed'; finish(); };
  child.once('exit', onExit);
  child.once('close', onExit);
  child.on('error', () => { state = 'failed'; });
  // Consume diagnostics without retaining or publishing them: they may contain secrets.
  let tail = '';
  child.stderr?.on('data', (data: Buffer) => {
    const text = tail + data.toString('utf8');
    if (!closing && state !== 'failed' && text.includes('Registered tunnel connection')) state = 'connection-ready';
    tail = text.slice(-256);
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => { if (state === 'starting') state = 'spawned'; resolve(); });
    child.once('error', () => reject(new Error('Tunnel process could not start')));
  });
  let closePromise: Promise<void> | undefined;
  return {
    status: () => ({ state, publicReachabilityVerified: false }),
    close() {
      return closePromise ??= (async () => {
        closing = true;
        if (ended) { state = 'stopped'; return; }
        child.kill('SIGTERM');
        const escalation = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 2000);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => { state = 'failed'; reject(new Error('Tunnel termination was not confirmed')); }, 5000);
        });
        try { await Promise.race([exited, timeout]); }
        finally { clearTimeout(escalation); clearTimeout(deadline); }
      })();
    },
  };
}
