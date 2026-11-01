import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Runtime } from './runtime.js';
import { Delivery, registerTrustContext } from './delivery.js';
import { retire, drainRetired } from './ownership.js';

/** Explicit session ownership; factory registration never opens a socket or starts a process. */
export default function messageIngest(pi: ExtensionAPI): void {
  let runtime: Runtime | undefined;
  let delivery: Delivery | undefined;
  let context: ExtensionContext | undefined;
  let boundSessionId: string | undefined;
  let generation = 0;
  registerTrustContext(pi);

  const current = (ctx: ExtensionContext): Runtime => {
    if (!runtime || !context || context.sessionManager !== ctx.sessionManager ||
        boundSessionId !== ctx.sessionManager.getSessionId()) {
      throw new Error('Message-ingest requires an active persistent Pi session and confirmed resource cleanup');
    }
    return runtime;
  };
  const replaceDelivery = (ctx: ExtensionContext) => {
    const discarded = delivery?.close() ?? 0;
    delivery = new Delivery(pi, ctx);
    return discarded;
  };
  const status = (ctx: ExtensionContext) => ({ ...current(ctx).status(), delivery: delivery?.status() });
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: undefined });

  pi.on('session_start', async (_event, ctx) => {
    const expected = ++generation;
    delivery?.close(); delivery = undefined;
    const previous = runtime;
    runtime = undefined; context = undefined; boundSessionId = undefined;
    if (previous) await retire(previous);
    await drainRetired();
    if (expected !== generation) return;
    // In-memory sessions cannot be resumed and must never acquire saved exposure.
    if (!ctx.sessionManager.getSessionFile()) return;
    context = ctx;
    boundSessionId = ctx.sessionManager.getSessionId();
    delivery = new Delivery(pi, ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const created = new Runtime({
      sessionId: () => ctx.sessionManager.getSessionId(),
      deliver: text => {
        if (expected !== generation || context !== ctx || ctx.sessionManager.getSessionId() !== sessionId || !delivery) throw new Error('Message-ingest session was replaced');
        delivery.enqueue(text);
      },
    }, { projectDirectory: ctx.cwd });
    runtime = created;
    try { await created.start(); }
    catch { if (expected === generation) ctx.ui.notify('Message-ingest did not start. Check its status and local configuration.', 'warning'); }
  });
  pi.on('session_shutdown', async () => {
    ++generation;
    delivery?.close(); delivery = undefined;
    const previous = runtime;
    runtime = undefined; context = undefined; boundSessionId = undefined;
    if (previous) await retire(previous);
  });
  pi.on('agent_settled', () => delivery?.settled());

  pi.registerTool({
    name: 'message_ingest_status', label: 'Message ingest status',
    description: 'Read this session’s saved mapping, listener/tunnel readiness and volatile inbox status. Never returns the bearer token. Unmapped sessions start no resources.',
    parameters: Type.Object({}),
    execute: async (_id, _args, _signal, _update, ctx) => result(!ctx.sessionManager.getSessionFile()
      ? { sessionId: ctx.sessionManager.getSessionId(), configured: false, listener: 'stopped', reason: 'Persistent session required' }
      : status(ctx)),
  });
  pi.registerTool({
    name: 'message_ingest_token', label: 'Read message ingest token',
    description: 'On the owner’s explicit request, read and return the current session mapping’s bearer token so they can securely transfer it to a client. Intentionally reveals the token in this result and conversation. Does not rotate the token, enable the listener or restart anything. Routine status remains redacted.',
    parameters: Type.Object({}),
    execute: async (_id, _args, _signal, _update, ctx) => result(await current(ctx).token()),
  });
  pi.registerTool({
    name: 'message_ingest_configure', label: 'Configure message ingest',
    description: 'Save a listener and optional existing managed Cloudflare Tunnel configuration for this exact current persistent session ID. Stops any old listener/tunnel and leaves the mapping disabled; enable separately. Generates a bearer token for a new mapping, or rotates it when requested, and RETURNS THE TOKEN for the owner to copy. The token is intentionally present in this tool result/session transcript. No tunnel provisioning, arbitrary command execution or public exposure. Omitting tunnel removes its configuration.',
    parameters: Type.Object({
      port: Type.Integer({ minimum: 1, maximum: 65535 }),
      host: Type.Optional(Type.String({ description: 'Literal bind IP. Defaults to 127.0.0.1. LAN binding must be explicitly requested.' })),
      tunnel: Type.Optional(Type.Object({
        enabled: Type.Boolean(),
        configFile: Type.Optional(Type.String({ description: 'Absolute path to an existing local cloudflared named-tunnel config. Supply exactly one of configFile or tokenFile.' })),
        tokenFile: Type.Optional(Type.String({ description: 'Absolute path to a private connector-token file for a remotely managed tunnel. cloudflared reads it directly; never supply token contents. Remote ingress must already target this listener.' })),
      })),
      rotateToken: Type.Optional(Type.Boolean({ description: 'Generate a replacement bearer token; previous token stops working.' })),
    }),
    execute: async (_id, args, _signal, _update, ctx) => {
      const target = current(ctx);
      const discarded = replaceDelivery(ctx);
      return result({ ...await target.configure(args), discardedWaitingMessages: discarded,
        warning: 'Bearer token is intentionally included for setup. Protect this conversation and session transcript.' });
    },
  });
  pi.registerTool({
    name: 'message_ingest_enable', label: 'Enable message ingest',
    description: 'Enable and start only this session’s existing saved mapping. No mapping means no listener/tunnel. Starts a configured enabled tunnel only after its listener is ready. This can expose the configured bind interface or tunnel: use only with owner authorization.',
    parameters: Type.Object({}),
    execute: async (_id, _args, _signal, _update, ctx) => {
      const target = current(ctx);
      if (target.isRunning()) return result(status(ctx));
      // Restart fences any waiting input before the runtime invalidates its old listener.
      const discarded = replaceDelivery(ctx);
      return result({ ...await target.enable(), discardedWaitingMessages: discarded });
    },
  });
  pi.registerTool({
    name: 'message_ingest_disable', label: 'Disable message ingest',
    description: 'Disable this exact session’s saved mapping, stop new intake and extension-owned listener/tunnel, and discard extension-owned waiting bodies. Preserve configuration/token. Cannot retract messages already submitted to Pi or stop an independently managed tunnel.',
    parameters: Type.Object({}),
    execute: async (_id, _args, _signal, _update, ctx) => {
      const target = current(ctx);
      const discarded = replaceDelivery(ctx);
      return result({ ...await target.disable(), discardedWaitingMessages: discarded, piSubmittedWorkCancelled: false });
    },
  });
}
