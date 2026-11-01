import { ConfigStore, configuredMapping, publicMapping, type ConfigureInput, type Mapping, type PublicMapping } from './config.js';
import { listen, type Listener } from './transport.js';
import { startTunnel, type Tunnel, type TunnelStarter, type TunnelStatus } from './tunnel.js';

export interface Host { sessionId(): string; deliver(text: string): void; notify?(text: string): void }
export interface RuntimeOptions { projectDirectory: string; store?: ConfigStore; listen?: typeof listen; startTunnel?: TunnelStarter }
export interface RuntimeStatus {
  sessionId: string;
  configured: boolean;
  mapping?: PublicMapping;
  listener: 'stopped' | 'starting' | 'ready' | 'failed';
  tunnel: TunnelStatus | { state: 'not-configured' | 'disabled' };
  error?: string;
}
export interface ConfigureResult { token: string; status: RuntimeStatus }
/** Lifecycle methods serialize cleanup and fence delivery immediately at invocation. */
export class Runtime {
  readonly store: ConfigStore;
  private generation = 0;
  private operations = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private initialId = '';
  private mapping?: Mapping;
  private listener?: Listener;
  private tunnel?: Tunnel;
  private listenerState: RuntimeStatus['listener'] = 'stopped';
  private failure?: string;
  constructor(readonly host: Host, readonly options: RuntimeOptions) {
    this.store = options.store ?? new ConfigStore(options.projectDirectory);
  }
  status(): RuntimeStatus {
    const current = this.host.sessionId() === this.initialId;
    return { sessionId: this.host.sessionId(), configured: current && !!this.mapping,
      ...(current && this.mapping ? { mapping: publicMapping(this.mapping) } : {}),
      listener: current ? (this.listenerState === 'ready' && this.listener?.isReady?.() === false ? 'failed' : this.listenerState) : 'stopped',
      tunnel: current && this.tunnel ? this.tunnel.status()
        : current && this.mapping?.tunnel?.enabled ? { state: 'stopped', publicReachabilityVerified: false }
        : { state: current && this.mapping?.tunnel ? 'disabled' : 'not-configured' },
      ...(current && this.failure ? { error: this.failure } : {}) };
  }
  private operation<T>(work: (id: string, guard: () => void) => Promise<T>): Promise<T> {
    this.operations++;
    const generation = ++this.generation, id = this.host.sessionId();
    const guard = () => { if (generation !== this.generation || id !== this.host.sessionId()) throw new Error('Message-ingest lifecycle changed'); };
    const result = this.chain.catch(() => {}).then(async () => {
      await this.cleanup(); guard();
      this.initialId = id; this.failure = undefined; this.mapping = undefined;
      try { return await work(id, guard); }
      catch (error) {
        const listenerFailed = this.listenerState === 'failed';
        await this.cleanup();
        if (generation === this.generation) {
          this.failure = 'Message-ingest operation failed';
          if (listenerFailed) this.listenerState = 'failed';
        }
        // Only deliberately public messages escape; OS errors and token-bearing objects never do.
        throw new Error(error instanceof Error && ['Listener port is already in use', 'No mapping for current session', 'Message-ingest lifecycle changed'].includes(error.message) ? error.message : 'Message-ingest operation failed');
      }
    });
    const settled = result.finally(() => { this.operations--; });
    this.chain = settled;
    return settled;
  }
  private async cleanup(): Promise<void> {
    const listener = this.listener, tunnel = this.tunnel;
    this.listenerState = 'stopped';
    // Retain ownership on uncertain cleanup so later lifecycle calls cannot start replacements.
    await Promise.all([listener?.close(), tunnel?.close()]);
    this.listener = undefined; this.tunnel = undefined;
  }
  private async activate(id: string, guard: () => void): Promise<void> {
    if (!this.mapping?.enabled) return;
    const generation = this.generation, mapping = this.mapping;
    this.listenerState = 'starting';
    try {
      const listener = await (this.options.listen ?? listen)({ host: mapping.host, port: mapping.port, token: mapping.token,
        isCurrent: () => generation === this.generation && id === this.host.sessionId(),
        deliver: text => { guard(); this.host.deliver(text); } });
      this.listener = listener; guard(); this.listenerState = 'ready';
      if (mapping.tunnel?.enabled) {
        const tunnel = await (this.options.startTunnel ?? startTunnel)(mapping.tunnel);
        this.tunnel = tunnel; guard();
      }
    } catch (error) { this.listenerState = 'failed'; throw error; }
  }
  start(): Promise<RuntimeStatus> {
    return this.operation(async (id, guard) => {
      const config = await this.store.read(); guard(); this.mapping = config.sessions[id];
      await this.activate(id, guard); return this.status();
    });
  }
  close(): Promise<void> {
    ++this.generation; this.operations++;
    const result = this.chain.catch(() => {}).then(async () => { await this.cleanup(); }).finally(() => { this.operations--; });
    this.chain = result; return result;
  }
  /** Explicit credential retrieval never starts/stops resources or rotates the credential. */
  async token(): Promise<{ sessionId: string; token: string }> {
    const generation = this.generation, id = this.host.sessionId();
    if (id !== this.initialId || this.operations !== 0) throw new Error('Message-ingest session is not ready');
    const config = await this.store.read();
    if (generation !== this.generation || id !== this.host.sessionId()) throw new Error('Message-ingest lifecycle changed');
    const mapping = config.sessions[id];
    if (!mapping) throw new Error('No mapping for current session');
    return { sessionId: id, token: mapping.token };
  }
  /** Configuration always disables the mapping; explicitly enable afterward. Token return is intentional. */
  configure(input: ConfigureInput): Promise<ConfigureResult> {
    return this.operation(async (id, guard) => {
      const config = await this.store.update(c => { c.sessions[id] = configuredMapping(input, c.sessions[id]); }, guard);
      guard(); this.mapping = config.sessions[id]!;
      return { token: this.mapping.token, status: this.status() };
    });
  }
  isRunning(): boolean {
    return this.operations === 0 && this.initialId === this.host.sessionId() && this.mapping?.enabled === true && this.status().listener === 'ready'
      && (!this.mapping.tunnel?.enabled || ['spawned', 'connection-ready'].includes(this.tunnel?.status().state ?? ''));
  }
  enable(): Promise<RuntimeStatus> { return this.isRunning() ? Promise.resolve(this.status()) : this.setEnabled(true); }
  disable(): Promise<RuntimeStatus> { return this.setEnabled(false); }
  private setEnabled(enabled: boolean): Promise<RuntimeStatus> {
    return this.operation(async (id, guard) => {
      const previous = await this.store.read(); guard();
      if (!previous.sessions[id]) { if (enabled) throw new Error('No mapping for current session'); return this.status(); }
      const config = await this.store.update(c => {
        if (!c.sessions[id]) throw new Error('No mapping for current session');
        c.sessions[id]!.enabled = enabled;
      }, guard);
      guard(); this.mapping = config.sessions[id];
      await this.activate(id, guard); return this.status();
    });
  }
}
