import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

// Run the production write handlers against delayed IPC replies, with no app or device.
function editor({ combo = false, confirmation = false } = {}) {
  const controls = new Map(), calls = [], messages = [], pending = [];
  const confirm = deferred();
  const $ = id => { if (!controls.has(id)) controls.set(id, { value: id === 'onboard-profile' ? '2' : '', disabled: false }); return controls.get(id); };
  const context = {
    $, state: { status: { connected: true, device: { id: 7, path: '/device/a', kind: 'device', connection: 'USB' }, settings: { dpi: { currentDpi: 0, currentDPIMax: 1, dpiArr: [800,0,0,0,0,0,0,0,800], DPIColorArr: [1] }, options: { rate: 1000, deBounce: 2 }, keyMappings: [[1, 0, 240, 0]] } } },
    macroDeviceIdentity: () => { const d = context.state.status.device; return context.state.status.connected && d ? JSON.stringify([d.path, d.kind, d.id, d.connection]) : null; },
    clone: structuredClone, same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    can: () => true, canRate: () => true, caps: () => ({ pollingRates: [1000, 2000] }),
    mappingActions: { right: [1, 0, 241, 0] }, buttonNames: ['Left button'],
    buttonControls: [{ select: { value: combo ? 'combo' : 'right' }, combo: { value: 'Ctrl+A' } }],
    optionFields: {}, editorOptions: () => ({ rate: 2000 }), dpiPatch: value => value,
    dpiPatch: value => value, validateDpi: value => value, caps: () => ({ pollingRates: [1000, 2000] }), liftLevels: () => [0, 1], bounded() {},
    syncQuickSettings() {}, syncButtons() {}, syncRates() {}, syncOptions() {}, renderDpiStages() {}, navigate() {}, renderMapping() {}, markPerformance() { context.editPerformance(); },
    discard: () => confirmation ? confirm.promise : Promise.resolve(true),
    toast: (message, error) => messages.push({ message, error }),
    api: (...args) => { const wait = deferred(); calls.push(args); pending.push(wait); return wait.promise; },
    refresh: async () => {},
    renderStatus: () => { for (const id of ['apply-buttons', 'apply-performance', 'switch-profile']) $(id).disabled = context.snapshot().busy; }
  };
  runInNewContext(`
    let performanceBusy=false,performanceDirty=true,performanceOrigin='["/device/a","device",7,"USB"]',performanceRevision=0,performanceBaseline=null,dpiDraft=null,buttonRevision=0,buttonsOrigin='["/device/a","device",7,"USB"]',onboardProfileRevision=0,onboardProfileDirty=true;
    const dirtyButtons=new Set([0]),buttonDrafts=new Map();
    const supportedOptions=['rate','deBounce','liftCutOff','angelSnap','smooth','powerSaveMode'];
    let assignmentMacroPick='',assignmentMacroPickSlot='',macroPickSignature=null,macroAssignmentReturn=null;
    const assignmentMacroPicks=new Map(),assignmentPickDevices=new Map(),assignmentChoiceVersions=new Map(),assignmentRawChoices=new Set();
    ${between('function resetMacroAssignmentDraftState()', 'function bumpAssignmentChoice(index)')}
    ${between('function sanitizeSettings(input,', 'async function snapshotSettings()')}
    ${between('async function applyPerformance(){', "$('apply-performance').onclick")}
    ${between('async function mappingFor(index)', "for(const type of ['input','change'])")}
    ${between("$('switch-profile').onclick=", "const mouseButtons=")}
    ${between('async function loadProfile(profile)', 'function renderProfiles(){')}
    globalThis.applyPerformance=applyPerformance; globalThis.applyProfile=applyProfile; globalThis.loadProfile=loadProfile;
    globalThis.editButtons=()=>{if(!dirtyButtons.size)buttonsOrigin=macroDeviceIdentity();buttonRevision++;dirtyButtons.add(0);buttonDrafts.set(0,[9,2,7,0]);};
    globalThis.editPerformance=()=>{if(!performanceDirty)performanceOrigin=macroDeviceIdentity();performanceRevision++;performanceDirty=true;};
    globalThis.editOnboard=()=>{onboardProfileRevision++;onboardProfileDirty=true;};
    globalThis.seedPicks=()=>{assignmentMacroPick='picked';assignmentMacroPickSlot='7';macroPickSignature='cached';macroAssignmentReturn={index:0};assignmentMacroPicks.set(0,'macro-a');assignmentPickDevices.set(0,'device-a');assignmentChoiceVersions.set(0,1);assignmentRawChoices.add(0);};
    globalThis.currentDevice=(path,settings)=>{state.status.device.path=path;if(settings)state.status.settings=settings;};
    globalThis.snapshot=()=>({busy:performanceBusy,performanceDirty,performanceOrigin,performanceBaseline,dpiDraft,buttons:[...dirtyButtons],buttonsOrigin,draft:buttonDrafts.get(0),onboardProfileDirty,picks:assignmentMacroPicks.size,raw:assignmentRawChoices.size,versions:assignmentChoiceVersions.size,returning:macroAssignmentReturn});
  `, context);
  return { context, $, calls, messages, pending, confirm, applyButtons: () => $('apply-buttons').onclick(), switchProfile: () => $('switch-profile').onclick() };
}

test('button writes preserve newer edits and block every competing settings writer', async () => {
  const e = editor(), save = e.applyButtons();
  await tick();
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0]?.[2]?.device, '["/device/a","device",7,"USB"]', JSON.stringify(e.messages));
  e.context.editButtons();
  await Promise.all([e.applyButtons(), e.context.applyPerformance(), e.context.applyProfile({ settings: { options: { rate: 2000 } } }), e.switchProfile()]);
  assert.equal(e.calls.length, 1);
  assert.equal(e.$('apply-buttons').disabled, true);
  e.pending[0].resolve({}); await save;
  assert.equal(e.context.snapshot().buttons.length, 1);
  assert.equal(JSON.stringify(e.context.snapshot().draft), '[9,2,7,0]');
  assert.equal(e.context.snapshot().busy, false);
  assert.equal(e.$('apply-buttons').disabled, false);
});

test('unchanged button save clears only after success; failure retains drafts and releases lock', async () => {
  for (const fail of [false, true]) {
    const e = editor(), save = e.applyButtons(); await tick();
    if (fail) { e.context.editButtons(); e.pending[0].reject(Error('write failed')); }
    else e.pending[0].resolve({});
    await save;
    assert.equal(e.context.snapshot().buttons.length, fail ? 1 : 0);
    assert.equal(e.context.snapshot().busy, false);
    if (fail) assert.equal(e.messages.at(-1).message, 'write failed');
  }
});

test('a changed combo draft aborts compilation before a physical settings write', async () => {
  const e = editor({ combo: true }), save = e.applyButtons();
  assert.equal(e.calls[0][0], '/api/key/compile');
  e.context.editButtons();
  e.pending[0].resolve({ mapping: [0, 1, 4, 0] }); await save;
  assert.equal(e.calls.length, 1);
  assert.match(e.messages.at(-1).message, /changed while preparing/);
  assert.equal(e.context.snapshot().buttons.length, 1);
  assert.equal(e.context.snapshot().busy, false);
});

test('A-origin performance and button drafts cannot be posted to mouse B', async () => {
  const e = editor();
  e.context.currentDevice('/device/b');
  await e.context.applyPerformance();
  await e.applyButtons();
  assert.equal(e.calls.length, 0);
  assert.match(e.messages[0].message, /selected mouse changed/i);
  assert.match(e.messages[1].message, /selected mouse changed/i);
  assert.equal(e.context.snapshot().performanceOrigin, '["/device/a","device",7,"USB"]');
  assert.equal(e.context.snapshot().buttonsOrigin, '["/device/a","device",7,"USB"]');
});

test('a performance draft can still be applied to its originating mouse and carries that identity', async () => {
  const e = editor(), save = e.context.applyPerformance(); await tick();
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0][0], '/api/settings');
  assert.equal(e.calls[0][2].device, '["/device/a","device",7,"USB"]');
  e.pending[0].resolve({}); await save;
});

test('a device change during combo preparation aborts the pending button write', async () => {
  const e = editor({ combo: true }), save = e.applyButtons();
  assert.equal(e.calls[0][0], '/api/key/compile');
  e.context.currentDevice('/device/b');
  e.pending[0].resolve({ mapping: [0, 1, 4, 0] }); await save;
  assert.equal(e.calls.length, 1);
  assert.match(e.messages.at(-1).message, /selected mouse changed/i);
  assert.equal(e.context.snapshot().buttons.length, 1);
});

test('profile apply rechecks its starting device after confirmation', async () => {
  const e = editor({ confirmation: true }), apply = e.context.applyProfile({ settings: { options: { rate: 2000 } } });
  await tick();
  e.context.currentDevice('/device/b');
  e.confirm.resolve(true);
  await apply;
  assert.equal(e.calls.length, 0);
  assert.match(e.messages.at(-1).message, /selected mouse changed/i);
});

test('profile apply clears old named-macro picker state only after an unchanged successful apply', async () => {
  const e = editor(); e.context.seedPicks();
  const apply = e.context.applyProfile({ settings: { options: { rate: 2000 } } }); await tick();
  assert.equal(e.calls[0]?.[2]?.device, '["/device/a","device",7,"USB"]', JSON.stringify(e.messages));
  e.pending[0].resolve({}); await apply;
  assert.equal(e.context.snapshot().picks, 0);
  assert.equal(e.context.snapshot().raw, 0);
  assert.equal(e.context.snapshot().versions, 0);
  assert.equal(e.context.snapshot().returning, null);
});

test('successful onboard profile switch clears old picker state after its identity-bound write', async () => {
  const e = editor(); e.context.seedPicks();
  const save = e.switchProfile(); await tick();
  assert.equal(e.calls[0][0], '/api/profile');
  assert.equal(e.calls[0][2].device, '["/device/a","device",7,"USB"]');
  e.pending[0].resolve({}); await save;
  assert.equal(e.context.snapshot().picks, 0);
  assert.equal(e.context.snapshot().raw, 0);
  assert.equal(e.context.snapshot().versions, 0);
  assert.equal(e.context.snapshot().returning, null);
});

test('reverting while combo compilation is delayed invalidates the pending write', async () => {
  const e = editor({ combo: true }), save = e.applyButtons();
  e.$('revert-buttons').onclick();
  e.pending[0].resolve({ mapping: [0, 1, 4, 0] }); await save;
  assert.equal(e.calls.length, 1);
  assert.equal(e.context.snapshot().buttons.length, 0);
});

for (const kind of ['local', 'onboard']) for (const fail of [false, true]) {
  test(`${kind} profile ${fail ? 'failure' : 'success'} preserves newer editor drafts`, async () => {
    const e = editor();
    const save = kind === 'local' ? e.context.applyProfile({ settings: { options: { rate: 2000 } } }) : e.switchProfile();
    await tick(); assert.equal(e.calls.length, 1);
    if (kind === 'onboard') {
      assert.equal(e.calls[0][0], '/api/profile');
      assert.equal(e.calls[0][2].device, '["/device/a","device",7,"USB"]');
    } else assert.equal(e.calls[0][2].device, '["/device/a","device",7,"USB"]');
    e.context.editPerformance(); e.context.editButtons(); e.context.editOnboard();
    await e.applyButtons(); assert.equal(e.calls.length, 1);
    if (fail) e.pending[0].reject(Error('profile failed')); else e.pending[0].resolve({});
    await save;
    assert.equal(e.context.snapshot().performanceDirty, true);
    assert.equal(e.context.snapshot().buttons.length, 1);
    assert.equal(e.context.snapshot().onboardProfileDirty, true);
    assert.equal(e.context.snapshot().busy, false);
  });
}

test('profile confirmation holds the shared lock and cancellation releases it', async () => {
  const e = editor({ confirmation: true }), save = e.context.applyProfile({ settings: { options: { rate: 2000 } } });
  await Promise.all([e.switchProfile(), e.applyButtons(), e.context.applyPerformance()]);
  assert.equal(e.calls.length, 0); assert.equal(e.context.snapshot().busy, true);
  e.confirm.resolve(false); await save;
  assert.equal(e.context.snapshot().busy, false);
  assert.equal(e.context.snapshot().performanceDirty, true);
});

test('loading another profile during a delayed write preserves the loaded draft', async () => {
  const e = editor(), save = e.context.applyProfile({ settings: { options: { rate: 2000 } } });
  await tick();
  await e.context.loadProfile({ settings: { keyMappings: [[9, 2, 7, 0]] } });
  e.pending[0].resolve({}); await save;
  assert.equal(e.context.snapshot().performanceDirty, false);
  assert.equal(JSON.stringify(e.context.snapshot().draft), '[9,2,7,0]');
});

test('loading a partial profile on mouse B starts from B settings instead of retargeting mouse A drafts', async () => {
  const e = editor(); e.context.seedPicks();
  e.context.currentDevice('/device/b', {
    dpi: { currentDpi: 0, currentDPIMax: 1, dpiArr: [1600,0,0,0,0,0,0,0,1600], DPIColorArr: [2] },
    options: { rate: 2000, deBounce: 4 }, keyMappings: [[1, 0, 241, 0]]
  });
  await e.context.loadProfile({ settings: { keyMappings: [[9, 2, 7, 0]] } });
  assert.equal(e.context.snapshot().dpiDraft.dpiArr[0], 1600);
  assert.equal(e.context.snapshot().performanceBaseline.options.rate, 2000);
  assert.equal(e.context.snapshot().buttonsOrigin, '["/device/b","device",7,"USB"]');
  assert.equal(e.context.snapshot().draft[2], 7);
  assert.equal(e.context.snapshot().picks, 0);
  assert.equal(e.context.snapshot().raw, 0);
  assert.equal(e.context.snapshot().versions, 0);
  assert.equal(e.context.snapshot().returning, null);
});

test('legacy single-DPI profile import overlays mouse B full DPI baseline, not mouse A draft', async () => {
  const e = editor();
  e.context.currentDevice('/device/b', {
    dpi: { currentDpi: 1, currentDPIMax: 3, dpiArr: [500,1000,1500,2000,2500,3000,3500,4000,500,1000,1500,2000,2500,3000,3500,4000], DPIColorArr: [1,2,3] },
    options: { rate: 2000 }, keyMappings: [[1,0,241,0]]
  });
  await e.context.loadProfile({ settings: { dpi: 2400 } });
  const dpi = e.context.snapshot().dpiDraft;
  assert.equal(dpi.currentDPIMax, 3);
  assert.equal(dpi.dpiArr[0], 500);
  assert.equal(dpi.dpiArr[1], 2400);
  assert.equal(dpi.dpiArr[9], 2400);
  assert.equal(dpi.dpiArr[2], 1500);
  assert.deepEqual(Array.from(dpi.DPIColorArr), [1,2,3]);
  assert.equal(e.context.snapshot().performanceOrigin, '["/device/b","device",7,"USB"]');
});

test('legacy profile sanitizer defaults to verified device settings for import and direct Apply', () => {
  const context = {
    state: {status: {settings: {dpi: {currentDpi:0,currentDPIMax:2,dpiArr:[800,1600,0,0,0,0,0,0,800,1600],DPIColorArr:[1,2]}}}},
    dpiDraft: {currentDpi:0,currentDPIMax:2,dpiArr:[400,3200,0,0,0,0,0,0,400,3200]},
    clone: structuredClone, dpiPatch: structuredClone, validateDpi() {},
  };
  runInNewContext(`${between('function sanitizeSettings(', 'async function snapshotSettings(')}globalThis.sanitize=sanitizeSettings;`, context);
  const result = context.sanitize({dpi:1200});
  assert.equal(result.dpi.dpiArr[0],1200);
  assert.equal(result.dpi.dpiArr[8],1200);
  assert.equal(result.dpi.dpiArr[1],1600);
  context.state.status.settings=null;
  assert.throws(()=>context.sanitize({dpi:1200}),/Connect your mouse/);
});
