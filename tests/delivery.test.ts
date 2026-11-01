import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Delivery, MAX_PENDING } from '../src/delivery.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  let idle = true, id = 'session';
  const sent: string[] = [], notices: string[] = [];
  const ctx = { sessionManager: { getSessionId: () => id }, isIdle: () => idle, hasPendingMessages: () => false,
    ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
  const pi = { sendMessage: (message: { content: string }, options: unknown) => {
    assert.deepEqual(options, { triggerTurn: true, deliverAs: 'followUp' }); sent.push(message.content);
  } } as unknown as ExtensionAPI;
  const delivery = new Delivery(pi, ctx);
  return { delivery, sent, notices, idle: (value: boolean) => { idle = value; }, id: (value: string) => { id = value; } };
}
test('volatile inbox is bounded, waits for idle and discards queued content on close', async () => {
  const f = fixture(); f.idle(false);
  for (let n = 0; n < MAX_PENDING; n++) f.delivery.enqueue(`body ${n}`);
  assert.throws(() => f.delivery.enqueue('over capacity'), /full/);
  await wait(80); assert.deepEqual(f.sent, []);
  assert.equal(f.delivery.close(), MAX_PENDING);
  f.idle(true); await wait(80); assert.deepEqual(f.sent, []);
});
test('idle reconciliation recovers from asynchronous submission failure without replay', async () => {
  const f = fixture();
  try {
    // sendMessage returning void does not report asynchronous preparation failure.
    f.delivery.enqueue('first'); f.delivery.enqueue('second');
    await wait(280);
    assert.deepEqual(f.sent, ['first', 'second']);
    assert.equal(f.delivery.status().submitted, false);
    assert.ok(f.notices.some(text => text.includes('outcome unknown')));
  } finally { f.delivery.close(); }
});
test('captured session binding prevents waiting messages moving after a session ID change', async () => {
  const f = fixture(); f.idle(false); f.delivery.enqueue('old session body'); f.id('replacement');
  await wait(80); f.idle(true); await wait(80);
  assert.deepEqual(f.sent, []); assert.throws(() => f.delivery.enqueue('new'), /no longer active/);
});
