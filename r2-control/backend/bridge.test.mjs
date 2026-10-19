import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../app/bridge.js', import.meta.url), 'utf8');
function bridge(post) {
  const sent = [], timers = new Map();
  let timerId = 0;
  const window = { ipc: { postMessage(value) { sent.push(JSON.parse(value)); post?.(value); } } };
  runInNewContext(source, {
    window,
    TextEncoder,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  return { window, sent, timers, request: window.r2.request };
}

test('writes stay pending without a JS timeout and duplicate retries share the result', async () => {
  const b = bridge();
  const first = b.request('post', '/api/settings', { options: { rate: 1000 } });
  const second = b.request('POST', '/api/settings', { options: { rate: 1000 } });
  assert.equal(first, second);
  assert.equal(b.sent.length, 1);
  assert.equal(b.timers.size, 0);
  b.window.__r2Resolve({ id: b.sent[0].id, ok: true, data: { verified: true } });
  assert.equal((await first).verified, true);
  const next = b.request('POST', '/api/settings', { options: { rate: 1000 } });
  assert.equal(b.sent.length, 2);
  b.window.__r2Resolve({ id: b.sent[1].id, ok: true, data: null });
  await next;
});

test('a confirmed Rust failure releases the write for an explicit retry', async () => {
  const b = bridge();
  const first = b.request('PUT', '/api/macros', { macros: [] });
  const rejected = assert.rejects(first, /Disk full/);
  b.window.__r2Resolve({ id: b.sent[0].id, ok: false, error: 'Disk full' });
  await rejected;
  const retry = b.request('PUT', '/api/macros', { macros: [] });
  assert.equal(b.sent.length, 2);
  b.window.__r2Resolve({ id: b.sent[1].id, ok: true });
  await retry;
});

test('reads time out safely, ignore late replies, and can be retried', async () => {
  const b = bridge();
  const read = b.request('GET', '/api/status');
  const rejected = assert.rejects(read, /read has not completed/);
  [...b.timers.values()][0]();
  await rejected;
  assert.equal(b.timers.size, 0);
  b.window.__r2Resolve({ id: b.sent[0].id, ok: true, data: 'late' });
  const retry = b.request('GET', '/api/status');
  b.window.__r2Resolve({ id: b.sent[1].id, ok: true, data: 'current' });
  assert.equal(await retry, 'current');
  assert.equal(b.timers.size, 0);
});

test('out-of-order responses resolve only their own requests', async () => {
  const b = bridge();
  const one = b.request('PUT', '/api/macros', { macros: [1] });
  const two = b.request('PUT', '/api/macros', { macros: [2] });
  assert.equal(b.sent.length, 2);
  b.window.__r2Resolve({ id: b.sent[1].id, ok: true, data: 2 });
  b.window.__r2Resolve({ id: b.sent[0].id, ok: true, data: 1 });
  assert.deepEqual(await Promise.all([one, two]), [1, 2]);
});

test('serialization and transport failures reject without leaving a cached write', async () => {
  const b = bridge(() => { throw new Error('IPC unavailable'); });
  await assert.rejects(b.request('POST', '/api/settings', {}), /IPC unavailable/);
  await assert.rejects(b.request('POST', '/api/settings', {}), /IPC unavailable/);
  assert.equal(b.sent.length, 2);
  assert.equal(b.timers.size, 0);
  const circular = {}; circular.self = circular;
  await assert.rejects(b.request('PUT', '/api/macros', circular), /circular|cyclic/i);
  assert.equal(b.sent.length, 2);
});

test('oversized Unicode collections reject before IPC and do not leave a pending write', async () => {
  const b = bridge();
  // Below the character limit, but above the UTF-8 byte limit.
  const data = { macros: [{ name: '鼠'.repeat(350000) }] };
  assert.ok(JSON.stringify(data).length < 1024 * 1024);
  await assert.rejects(b.request('PUT', '/api/macros', data), /too large.*1 MiB/);
  await assert.rejects(b.request('PUT', '/api/macros', data), /too large.*1 MiB/);
  assert.equal(b.sent.length, 0);
  assert.equal(b.timers.size, 0);
  const retry = b.request('PUT', '/api/macros', { macros: [] });
  assert.equal(b.sent.length, 1);
  b.window.__r2Resolve({ id: b.sent[0].id, ok: true });
  await retry;
});
