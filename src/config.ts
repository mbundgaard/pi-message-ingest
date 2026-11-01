import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink, chmod, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

export interface TunnelConfig { enabled: boolean; configFile?: string; tokenFile?: string }
export interface Mapping { enabled: boolean; host: string; port: number; token: string; tunnel?: TunnelConfig }
export interface Config { version: 1; sessions: Record<string, Mapping> }
export interface ConfigureInput { port: number; host?: string; tunnel?: TunnelConfig; rotateToken?: boolean }
export type PublicMapping = Omit<Mapping, 'token'>;
export function publicMapping(mapping: Mapping): PublicMapping {
  return { enabled: mapping.enabled, host: mapping.host, port: mapping.port, ...(mapping.tunnel ? { tunnel: { ...mapping.tunnel } } : {}) };
}
export function validateMapping(value: unknown): Mapping {
  const m = value as Mapping;
  if (!m || typeof m !== 'object' || typeof m.enabled !== 'boolean' || typeof m.host !== 'string' || !isIP(m.host)
    || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535 || typeof m.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(m.token)) throw new Error('Invalid message-ingest mapping');
  if (m.tunnel) {
    const t = m.tunnel;
    const file = t.tokenFile ?? t.configFile;
    if (typeof t.enabled !== 'boolean' || (t.configFile !== undefined && t.tokenFile !== undefined)
      || typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw new Error('Invalid tunnel configuration');
  }
  return { ...publicMapping(m), token: m.token };
}
function validateConfig(value: unknown): Config {
  const c = value as Config;
  if (!c || c.version !== 1 || !c.sessions || typeof c.sessions !== 'object' || Array.isArray(c.sessions)) throw new Error('Invalid message-ingest configuration');
  const sessions: Record<string, Mapping> = Object.create(null);
  for (const [id, mapping] of Object.entries(c.sessions)) {
    if (!id || id.length > 1024) throw new Error('Invalid session ID');
    sessions[id] = validateMapping(mapping);
  }
  return { version: 1, sessions };
}
const writes = new Map<string, Promise<unknown>>();
/** Atomic writes are serialized in-process and by an exclusive lock across processes.
 * A lock left by a crashed writer fails closed; it is never silently stolen.
 */
export class ConfigStore {
  readonly file: string;
  readonly directory: string;
  constructor(readonly projectDirectory: string) {
    this.directory = path.resolve(projectDirectory, '.pi/message-ingest');
    this.file = path.join(this.directory, 'config.json');
  }
  private async checkPaths(create: boolean): Promise<void> {
    for (const dir of [path.dirname(this.directory), this.directory]) {
      if (create) await mkdir(dir, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e; });
      try { const st = await lstat(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe configuration directory'); }
      catch (e) { if (!create && (e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    }
    if (create) {
      await chmod(this.directory, 0o700);
      const ignore = path.join(this.directory, '.gitignore');
      try { await writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const st = await lstat(ignore);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || await readFile(ignore, 'utf8') !== '*\n') throw new Error('Unsafe configuration ignore file');
      }
    }
    try {
      const st = await lstat(this.file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (process.platform !== 'win32' && (st.mode & 0o077) !== 0) || st.size > 1024 * 1024) throw new Error('Unsafe configuration file');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  async read(): Promise<Config> {
    try {
      await this.checkPaths(false);
      return validateConfig(JSON.parse(await readFile(this.file, 'utf8')));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: Object.create(null) };
      throw new Error('Cannot read protected message-ingest configuration');
    }
  }
  async update(mutate: (config: Config) => void, guard: () => void = () => {}): Promise<Config> {
    const previous = writes.get(this.file) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      let temp: string | undefined;
      let lock: Awaited<ReturnType<typeof open>> | undefined;
      const lockFile = path.join(this.directory, 'config.lock');
      try {
        guard(); await this.checkPaths(true);
        const deadline = Date.now() + 2000;
        while (!lock) {
          guard();
          try { lock = await open(lockFile, 'wx', 0o600); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
            await delay(25);
          }
        }
        const config = await this.read(); guard(); mutate(config);
        const checked = validateConfig(config);
        temp = path.join(this.directory, `.config-${randomBytes(12).toString('hex')}.tmp`);
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(checked, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
        guard(); await rename(temp, this.file); temp = undefined;
        return checked;
      } catch { throw new Error('Cannot update message-ingest configuration'); }
      finally {
        if (temp) await unlink(temp).catch(() => {});
        if (lock) { await lock.close(); await unlink(lockFile).catch(() => {}); }
      }
    });
    writes.set(this.file, operation);
    try { return await operation; } finally { if (writes.get(this.file) === operation) writes.delete(this.file); }
  }
}
export function configuredMapping(input: ConfigureInput, previous?: Mapping): Mapping {
  return validateMapping({ enabled: false, host: input.host ?? '127.0.0.1', port: input.port,
    token: !previous || input.rotateToken ? randomBytes(32).toString('base64url') : previous.token,
    ...(input.tunnel ? { tunnel: input.tunnel } : {}) });
}
