import { createServer, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { Socket } from 'node:net';

export const MAX_BODY_BYTES = 64 * 1024;
export interface ListenerOptions { host: string; port: number; token: string; deliver(text: string): void; isCurrent(): boolean }
export interface Listener { host: string; port: number; isReady?(): boolean; close(): Promise<void> }
/** 202 means the synchronous host delivery call returned, not model processing or durable admission. */
export async function listen(options: ListenerOptions): Promise<Listener> {
  const expected = createHash('sha256').update(`Bearer ${options.token}`).digest();
  let closing = false;
  const sockets = new Set<Socket>();
  const respond = (res: ServerResponse, code: number) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close', 'Cache-Control': 'no-store' });
    res.end(code === 202 ? 'Accepted\n' : 'Request rejected\n');
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 1000 }, (req, res) => {
    if (closing || !options.isCurrent()) { respond(res, 503); return; }
    if (req.method !== 'POST' || req.url !== '/') { respond(res, 404); return; }
    const authCount = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === 'authorization').length;
    const auth = req.headers.authorization ?? '';
    if (authCount !== 1 || !timingSafeEqual(expected, createHash('sha256').update(auth).digest())) { respond(res, 401); return; }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') { respond(res, 415); return; }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) { respond(res, 413); return; }
    let size = 0, rejected = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { rejected = true; chunks.length = 0; respond(res, 413); return; }
      chunks.push(chunk);
    });
    req.on('error', () => { rejected = true; chunks.length = 0; });
    req.on('end', () => {
      if (rejected) return;
      if (closing || !options.isCurrent()) { respond(res, 503); return; }
      let text: string;
      // ignoreBOM=true preserves an initial UTF-8 BOM as U+FEFF rather than stripping it.
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
      catch { respond(res, 400); return; }
      try { options.deliver(text); } catch { respond(res, 503); return; }
      respond(res, 202);
    });
  });
  server.maxConnections = 32;
  server.setTimeout(15_000, socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => {
    const failed = (e: NodeJS.ErrnoException) => reject(new Error(e.code === 'EADDRINUSE' ? 'Listener port is already in use' : 'Listener could not start'));
    server.once('error', failed);
    server.listen({ host: options.host, port: options.port, exclusive: true }, () => { server.off('error', failed); resolve(); });
  });
  // Never leak OS error messages, request bodies, or credentials via an unhandled event.
  server.on('error', () => { closing = true; for (const socket of sockets) socket.destroy(); server.close(); });
  let closePromise: Promise<void> | undefined;
  return { host: options.host, port: options.port, isReady: () => !closing && server.listening, close() {
    closing = true;
    return closePromise ??= new Promise<void>(resolve => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });
  } };
}
