import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');

function editor({ fail = false } = {}) {
  let complete, isBusy = () => false;
  const calls = [], messages = [], control = { disabled: false };
  const context = {
    state: { status: { settings: { options: { rate: 1000 } } } },
    macroDeviceIdentity: () => 'device-a',
    $: id => id === 'apply-performance' ? control : ({ value: '' }),
    can: feature => feature === 'options',
    canRate: () => true,
    same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    clone: value => structuredClone(value),
    dpiDraft: null,
    editorOptions: () => ({ rate: 2000 }),
    optionFields: {},
    validateDpi() { throw new Error('unexpected DPI validation'); },
    dpiPatch: value => value,
    api: (...args) => {
      calls.push(args);
      return new Promise((resolve, reject) => { complete = () => fail ? reject(new Error('save failed')) : resolve({ settings: { options: { rate: 2000 } } }); });
    },
    refresh: async () => {},
    syncQuickSettings() {},
    toast: (message, isError) => messages.push({ message, isError }),
    renderStatus: () => { control.disabled = isBusy(); }
  };
  const start = source.indexOf('async function applyPerformance(){');
  const end = source.indexOf("$('apply-performance').onclick", start);
  assert.ok(start >= 0 && end > start, 'applyPerformance source markers exist');
  runInNewContext(`let performanceBaseline={options:{rate:1000}},performanceDirty=true,performanceOrigin='device-a',performanceRevision=0,performanceBusy=false,dpiDraft=null;\n` + source.slice(start, end) + `
    globalThis.apply = applyPerformance;
    globalThis.edit = () => { performanceRevision++; performanceDirty=true; };
    globalThis.snapshot = () => ({dirty:performanceDirty,busy:performanceBusy,baseline:performanceBaseline});
  `, context);
  isBusy = () => context.snapshot().busy;
  return { context, control, calls, messages, complete: () => complete() };
}

test('overlapping apply requests share one settings write', async () => {
  const e = editor();
  const first = e.context.apply(), second = e.context.apply();
  assert.equal(e.calls.length, 1);
  assert.equal(e.control.disabled, true);
  e.complete();
  await Promise.all([first, second]);
  assert.equal(JSON.stringify(e.calls[0]), JSON.stringify(['/api/settings', 'POST', { options: { rate: 2000 }, device: 'device-a' }]));
  assert.equal(e.context.snapshot().busy, false);
});

test('a newer edit made during the write stays dirty', async () => {
  const e = editor();
  const apply = e.context.apply();
  e.context.edit();
  e.complete();
  await apply;
  assert.equal(e.context.snapshot().dirty, true);
  assert.equal(e.context.snapshot().baseline.options.rate, 2000);
  assert.match(e.messages.at(-1).message, /Newer edits remain unsaved/);
});

test('an unchanged revision becomes clean after verified save', async () => {
  const e = editor();
  const apply = e.context.apply();
  e.complete();
  await apply;
  assert.equal(e.context.snapshot().dirty, false);
  assert.equal(e.context.snapshot().baseline.options.rate, 2000);
  assert.match(e.messages.at(-1).message, /applied and verified/);
});

test('a failed write keeps the draft dirty and releases the apply control', async () => {
  const e = editor({ fail: true });
  const apply = e.context.apply();
  e.complete();
  await apply;
  assert.equal(e.context.snapshot().dirty, true);
  assert.equal(e.context.snapshot().busy, false);
  assert.equal(e.control.disabled, false);
  assert.deepEqual(e.messages.at(-1), { message: 'save failed', isError: true });
});
