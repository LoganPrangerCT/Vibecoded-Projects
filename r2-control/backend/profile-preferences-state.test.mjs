import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function profileHarness() {
  const state = { profiles: [{ id: 'a', name: 'A' }] }, calls = [];
  const context = {
    state,
    renderProfiles() {},
    api(path, method, body) {
      const gate = deferred(); calls.push({ path, method, body, gate }); return gate.promise;
    },
  };
  const code = between('let profileMutation=Promise.resolve();', 'async function loadProfile(profile)');
  runInNewContext(`${code}\nglobalThis.persist=persistProfiles;`, context);
  return { state, calls, persist: context.persist };
}

async function finishInOrder(harness, operations, expectedPayloads) {
  for (let i = 0; i < operations.length; i++) {
    await tick();
    assert.equal(harness.calls.length, i + 1, 'only the next collection mutation is submitted');
    assert.deepEqual(harness.calls[i].body.profiles.map(item => item.id), expectedPayloads[i]);
    harness.calls[i].gate.resolve({});
  }
  await Promise.all(operations);
}

test('profile save and delete mutations derive their lists serially from the latest state', async () => {
  const h = profileHarness();
  const save = h.persist(current => [...current, { id: 'b', name: 'B' }]);
  const deletion = h.persist(current => current.filter(profile => profile.id !== 'a'));
  await finishInOrder(h, [save, deletion], [['a', 'b'], ['b']]);
  assert.deepEqual(h.state.profiles.map(item => item.id), ['b']);
});

test('profile import and delete interleaving preserves the imported profile', async () => {
  const h = profileHarness();
  const importing = h.persist(current => [...current, { id: 'imported', name: 'Imported' }]);
  const deletion = h.persist(current => current.filter(profile => profile.id !== 'a'));
  await finishInOrder(h, [importing, deletion], [['a', 'imported'], ['imported']]);
  assert.deepEqual(h.state.profiles.map(item => item.id), ['imported']);
});

function preferenceHarness() {
  const nodes = new Map(['run-background', 'open-login', 'save-preferences', 'preferences-status'].map(id => [id, { checked: false, disabled: false, textContent: '', onclick: null, onchange: null }]));
  const calls = [], messages = [];
  const context = {
    $: id => nodes.get(id),
    api(...args) { const gate = deferred(); calls.push({ args, gate }); return gate.promise; },
    toast(message) { messages.push(message); },
  };
  const handlers = between("for(const id of['run-background','open-login'])", 'async function loadResearch()');
  runInNewContext(`let preferenceDirty=false,preferenceRevision=0;\n${handlers}\nglobalThis.dirty=()=>preferenceDirty;`, context);
  return { nodes, calls, messages, context };
}

test('a newer preference edit stays dirty when an earlier save completes', async () => {
  const h = preferenceHarness();
  h.nodes.get('run-background').checked = false;
  h.nodes.get('run-background').onchange();
  const saving = h.nodes.get('save-preferences').onclick();
  await tick();
  assert.equal(JSON.stringify(h.calls[0].args), JSON.stringify(['/api/preferences', 'PUT', { runInBackground: false, openAtLogin: false }]));

  h.nodes.get('run-background').checked = true;
  h.nodes.get('run-background').onchange();
  h.calls[0].gate.resolve({});
  await saving;

  assert.equal(h.context.dirty(), true);
  assert.equal(h.nodes.get('preferences-status').textContent, 'Saved; newer edits remain unsaved.');
  assert.deepEqual(h.nodes.get('run-background').checked, true);
});

test('preference save clears dirty state when no newer edit occurred', async () => {
  const h = preferenceHarness();
  h.nodes.get('open-login').checked = true;
  h.nodes.get('open-login').onchange();
  const saving = h.nodes.get('save-preferences').onclick();
  await tick();
  h.calls[0].gate.resolve({});
  await saving;
  assert.equal(h.context.dirty(), false);
  assert.equal(h.nodes.get('preferences-status').textContent, 'Desktop preferences saved.');
});

test('overlapping preference saves are serialized and the newer snapshot is persisted last', async () => {
  const h = preferenceHarness();
  h.nodes.get('run-background').checked = false;
  h.nodes.get('run-background').onchange();
  const older = h.nodes.get('save-preferences').onclick();
  await tick();
  h.nodes.get('run-background').checked = true;
  h.nodes.get('run-background').onchange();
  const newer = h.nodes.get('save-preferences').onclick();
  await tick();
  assert.equal(h.calls.length, 1, 'the second preference write waits behind the first');
  h.calls[0].gate.resolve({});
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(JSON.stringify(h.calls[1].args[2]), JSON.stringify({ runInBackground: true, openAtLogin: false }));
  h.calls[1].gate.resolve({});
  await Promise.all([older, newer]);
  assert.equal(h.context.dirty(), false);
});

test('failed preference save toasts once, preserves dirty state, and releases the next queued save', async () => {
  const h = preferenceHarness();
  h.nodes.get('open-login').checked = true;
  h.nodes.get('open-login').onchange();
  const failed = h.nodes.get('save-preferences').onclick();
  const retry = h.nodes.get('save-preferences').onclick();
  await tick();
  h.calls[0].gate.reject(new Error('Registry unavailable'));
  await failed;
  assert.equal(h.context.dirty(), true);
  assert.deepEqual(h.messages, ['Registry unavailable']);

  await tick();
  assert.equal(h.calls.length, 2, 'the queued retry starts after the failed request');
  h.calls[1].gate.resolve({});
  await retry;
  assert.equal(h.context.dirty(), false);
  assert.deepEqual(h.messages, ['Registry unavailable', 'Desktop preferences saved.']);
});
