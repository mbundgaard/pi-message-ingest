import type { Runtime } from './runtime.js';

// Pi reloads extension modules. A process-wide fence must outlive the old module closure.
// Only retired runtimes enter this set; never inspect/stop unrelated active sessions or processes.
const key = Symbol.for('pi-message-ingest.retired-runtimes.v1');
const globals = globalThis as typeof globalThis & { [key]?: Set<Runtime> };
const retired = globals[key] ??= new Set<Runtime>();

export async function retire(runtime: Runtime): Promise<void> {
  retired.add(runtime);
  await runtime.close();
  retired.delete(runtime); // A rejected/uncertain close deliberately retains the fence.
}
export async function drainRetired(): Promise<void> {
  for (const runtime of retired) await retire(runtime);
}
