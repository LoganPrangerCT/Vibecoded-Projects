import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
// Exercise the production save routine with a deliberately delayed Rust reply.
// This uses no webview, filesystem writes, native windows, or hardware access.
function editor() {
  let complete;
  const saved = [], messages = [], control = { disabled: false };
  const context = {
    state: { selected: null, macros: [], macroDirty: true },
    draftMacro: () => ({ id: 'new-macro', name: 'Original', steps: [{ type: 'delay', value: 25 }] }),
    persistMacros: next => { saved.push(next); return new Promise(resolve => { complete = resolve; }); },
    $: () => control,
    renderMacros() {}, renderMacroState() {}, toast: message => messages.push(message)
  };
  const start = source.indexOf('async function saveMacro(){');
  const end = source.indexOf("$('save-macro').onclick", start);
  runInNewContext('let macroRevision=0,macroEditor=0,macroSave=null;\n' + source.slice(start, end) + `
    globalThis.save = saveMacro;
    globalThis.edit = () => { macroRevision++; state.macroDirty = true; };
    globalThis.replace = () => { macroEditor++; state.selected = 'other'; state.macroDirty = false; };
  `, context);
  return { context, control, saved, messages, complete: () => complete() };
}

test('double save submits one snapshot and restores the save control', async () => {
  const e = editor();
  const first = e.context.save(), second = e.context.save();
  assert.equal(e.saved.length, 1);
  assert.equal(e.control.disabled, true);
  e.complete();
  await Promise.all([first, second]);
  assert.equal(e.context.state.selected, 'new-macro');
  assert.equal(e.context.state.macroDirty, false);
  assert.equal(e.control.disabled, false);
});

test('edits made while Rust saves remain explicitly unsaved', async () => {
  const e = editor();
  const save = e.context.save();
  e.context.edit();
  e.complete();
  await save;
  assert.equal(e.context.state.selected, 'new-macro');
  assert.equal(e.context.state.macroDirty, true);
  assert.match(e.messages[0], /newer edits are still unsaved/);
});

test('finishing a save does not replace another sequence opened meanwhile', async () => {
  const e = editor();
  const save = e.context.save();
  e.context.replace();
  e.complete();
  await save;
  assert.equal(e.context.state.selected, 'other');
  assert.equal(e.context.state.macroDirty, false);
});

class Target {
  listeners = new Map();
  addEventListener(type, fn) { const set=this.listeners.get(type)||new Set(); set.add(fn); this.listeners.set(type,set); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  focus() {}
  fire(type, props={}) { const event={target:this,preventDefault(){},stopPropagation(){},...props}; for(const fn of this.listeners.get(type)||[])fn(event); }
}

function recorderTransition({ confirm }) {
  const module={exports:{}};runInNewContext(readFileSync(new URL('../app/recorder.js',import.meta.url),'utf8'),{module});
  const zone=new Target(),win=new Target(),controls=new Map(),state={selected:'old',macros:[{id:'new',name:'New',steps:[{type:'delay',value:10}]}],steps:[],events:[],macroDirty:false,slotRead:null};
  let now=0,recording=false,macroRevision=0,macroEditor=0;
  const control=id=>{if(!controls.has(id))controls.set(id,{value:id==='macro-playback'?'once':'',hidden:false});return controls.get(id);};
  const inputCapture=module.exports.create({zone,windowTarget:win,clock:()=>now,onEvent:event=>{state.events.push(event);macroRevision++;state.macroDirty=true;},onState:update=>{recording=update.recording;}});
  const context={state,inputCapture,recordButton:{disabled:false},recordArea:{hidden:true},recording,macroRevision,macroEditor,$:control,clone:structuredClone,
    discard:async()=>{assert.equal(inputCapture.isRecording(),false);assert.equal(state.events.at(-1).action,'up');return confirm;},
    stopRecording:()=>inputCapture.stop(),openMacroEditor(){},renderMacros(){},renderSteps(){},
  };
  const selectStart=source.indexOf('async function selectMacro('),selectEnd=source.indexOf('function syncMacroPlayback()',selectStart);
  const guardStart=source.indexOf('async function guardMacro()'),guardEnd=source.indexOf('// REVIEW',guardStart);
  const setTypesStart=source.indexOf('function setStepTypes()'),setTypesEnd=source.indexOf('let recording=false;',setTypesStart);
  runInNewContext(`let macroEditor=0,macroRevision=0,recording=false;
    ${source.slice(guardStart,guardEnd)}
    ${source.slice(setTypesStart,setTypesEnd)}
    ${source.slice(selectStart,selectEnd)}
    ${source.slice(source.indexOf('function syncMacroPlayback()'),source.indexOf('function valueInput(',source.indexOf('function syncMacroPlayback()')))}
    globalThis.select=selectMacro;`,context);
  inputCapture.start();zone.fire('mousedown',{button:0});now=20;
  return {context,inputCapture,select:context.select,state};
}

test('macro replacement stops the real recorder before confirmation and preserves the old balanced draft on cancel', async () => {
  const e=recorderTransition({confirm:false});
  await e.select('new');
  assert.equal(e.state.selected,'old');
  assert.deepEqual(e.state.events.map(event=>[event.type,event.value,event.action]),[
    ['mouse_button','left','down'],['delay',20,undefined],['mouse_button','left','up']
  ]);
  assert.equal(e.inputCapture.isRecording(),false);
});

test('skip-guard macro replacement still stops recording before swapping sequences', async () => {
  const e=recorderTransition({confirm:true});
  await e.select('new',true);
  assert.equal(e.state.selected,'new');
  assert.deepEqual(e.state.steps,[{type:'delay',value:10}]);
  assert.equal(e.state.events,null);
  assert.equal(e.inputCapture.isRecording(),false);
});
