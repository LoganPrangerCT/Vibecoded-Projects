import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context={module:{exports:{}}};
vm.runInNewContext(fs.readFileSync(new URL('../app/recorder.js',import.meta.url),'utf8'),context);
const {create,codeToHid,encodedBytes}=context.module.exports;
const plain=value=>JSON.parse(JSON.stringify(value));
class Target {
  listeners=new Map();
  addEventListener(type,fn) { const set=this.listeners.get(type)||new Set(); set.add(fn); this.listeners.set(type,set); }
  removeEventListener(type,fn) { this.listeners.get(type)?.delete(fn); }
  focus() { this.focused=true; }
  fire(type,props={}) {
    const event={target:this,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...props};
    for (const fn of this.listeners.get(type)||[]) fn(event);
    return event;
  }
}
function setup(options={}) {
  const zone=new Target(),win=new Target(),output=[],states=[];
  let now=0;
  const recorder=create({zone,windowTarget:win,clock:()=>now,onEvent:event=>output.push(event),onState:state=>states.push(state),...options});
  recorder.start();
  return {zone,win,recorder,output,states,at(time){now=time;}};
}
test('left click remains recording, preserving mouse hold and following keyboard timing',()=>{
  const x=setup();
  x.zone.fire('mousedown',{button:0});
  x.win.fire('blur',{target:x.zone}); // Focus moving within the app is not window blur.
  x.at(75); x.win.fire('mouseup',{button:0});
  assert.equal(x.recorder.isRecording(),true);
  x.at(100); x.zone.fire('keydown',{code:'KeyA'});
  x.at(140); x.win.fire('keyup',{code:'KeyA'});
  assert.deepEqual(plain(x.output),[
    {type:'mouse_button',value:'left',action:'down'}, {type:'delay',value:75},
    {type:'mouse_button',value:'left',action:'up'}, {type:'delay',value:25},
    {type:'keyboard',value:4,action:'down'}, {type:'delay',value:40},
    {type:'keyboard',value:4,action:'up'}
  ]);
});
test('modifier combos retain separate holds and ignore auto repeat',()=>{
  const x=setup();
  x.zone.fire('keydown',{code:'ControlLeft'});
  x.at(10);x.zone.fire('keydown',{code:'KeyC'});
  x.at(20);x.zone.fire('keydown',{code:'KeyC',repeat:true});
  x.at(60);x.win.fire('keyup',{code:'KeyC'});
  x.at(90);x.win.fire('keyup',{code:'ControlLeft'});
  assert.deepEqual(plain(x.output.filter(e=>e.type==='keyboard')), [
    {type:'keyboard',value:224,action:'down'}, {type:'keyboard',value:6,action:'down'},
    {type:'keyboard',value:6,action:'up'}, {type:'keyboard',value:224,action:'up'}
  ]);
  assert.deepEqual(plain(x.output.filter(e=>e.type==='delay').map(e=>e.value)),[10,50,30]);
});
test('all five buttons record down/up and suppress context menu and navigation',()=>{
  const x=setup();
  for (let button=0;button<5;button++) {
    assert.equal(x.zone.fire('mousedown',{button}).prevented,true);
    assert.equal(x.win.fire('mouseup',{button}).prevented,true);
  }
  for (const type of ['contextmenu','auxclick','click']) assert.equal(x.zone.fire(type).prevented,true);
  assert.deepEqual(plain(x.output.filter(e=>e.action==='down').map(e=>e.value)),['left','middle','right','back','forward']);
  assert.equal(x.recorder.isRecording(),true);
});
test('Escape, explicit stop, window blur and pointer cancellation balance held input',()=>{
  for (const trigger of ['escape','stop','blur','pointercancel','lostpointercapture']) {
    const x=setup();
    x.zone.fire('keydown',{code:'ShiftLeft'});
    x.zone.fire('mousedown',{button:2});
    x.at(25);
    if(trigger==='escape') x.zone.fire('keydown',{code:'Escape'});
    else if(trigger==='stop') x.recorder.stop();
    else if(trigger==='blur') x.win.fire('blur');
    else x.zone.fire(trigger);
    assert.equal(x.recorder.isRecording(),false,trigger);
    assert.deepEqual(plain(x.output.slice(-3)),[
      {type:'delay',value:25}, {type:'keyboard',value:225,action:'up'},
      {type:'mouse_button',value:'right',action:'up'}
    ]);
  }
});
test('event and byte preflight limits preserve balanced releases',()=>{
  for (const options of [{maxEvents:4},{canAcceptEvents:events=>events.length<=4}]) {
    const x=setup(options);
    x.zone.fire('keydown',{code:'KeyA'});
    x.at(10);x.zone.fire('keydown',{code:'KeyB'});
    assert.equal(x.recorder.isRecording(),false);
    assert.equal(x.states.at(-1).reason,'limit');
    assert.deepEqual(plain(x.output),[
      {type:'keyboard',value:4,action:'down'}, {type:'delay',value:10}, {type:'keyboard',value:4,action:'up'}
    ]);
  }
});
test('long delays split without truncation; restart and destroy clean up',()=>{
  const x=setup();
  x.zone.fire('keydown',{code:'KeyA'});
  x.at(70000);x.win.fire('keyup',{code:'KeyA'});
  assert.deepEqual(plain(x.output.filter(e=>e.type==='delay').map(e=>e.value)),[65535,4465]);
  x.recorder.stop();x.recorder.start();
  x.at(80000);x.zone.fire('keydown',{code:'KeyB'});
  assert.equal(x.recorder.getEvents()[0].type,'keyboard');
  x.recorder.destroy();
  assert.equal(x.recorder.isRecording(),false);
  for (const target of [x.zone,x.win]) for (const set of target.listeners.values()) assert.equal(set.size,0);
  assert.throws(()=>x.recorder.start(),/destroyed/);
});
test('physical keyboard codes map punctuation, function keys, numpad and modifiers',()=>{
  for (const [code,hid] of Object.entries({KeyZ:29,Digit0:39,Space:44,F12:69,F24:115,Numpad0:98,NumpadEnter:88,ControlRight:228,MetaRight:231})) assert.equal(codeToHid({code}),hid);
  assert.equal(codeToHid({code:'Unsupported'}),undefined);
});
test('byte accounting matches the shared Rust wire-encoder fixtures',()=>{
  const fixtures=JSON.parse(fs.readFileSync(new URL('./recorder-byte-fixtures.json',import.meta.url),'utf8'));
  for(const fixture of fixtures) assert.equal(encodedBytes(fixture.events),fixture.bytes,fixture.name);
});
test('byte limit reserves releases independently of the event count',()=>{
  const x=setup({maxBytes:8});
  x.zone.fire('keydown',{code:'KeyA'});
  x.at(200);x.zone.fire('keydown',{code:'KeyB'});
  assert.equal(x.recorder.isRecording(),false);
  assert.equal(x.states.at(-1).reason,'limit');
  assert.equal(encodedBytes(x.output),8);
  assert.equal(x.output.at(-1).action,'up');
  assert.equal(x.output.at(-1).value,4);
  assert.equal(x.states.at(-1).usedBytes,8);
});

test('event-count boundary stops before adding an event that cannot reserve held releases',()=>{
  const x=setup({maxEvents:4});
  x.zone.fire('keydown',{code:'KeyA'});
  x.win.fire('keyup',{code:'KeyA'});
  x.zone.fire('keydown',{code:'KeyB'});
  assert.equal(x.recorder.isRecording(),true);
  x.zone.fire('keydown',{code:'KeyC'});
  assert.equal(x.recorder.isRecording(),false);
  assert.equal(x.states.at(-1).reason,'limit');
  assert.deepEqual(plain(x.output),[
    {type:'keyboard',value:4,action:'down'}, {type:'keyboard',value:4,action:'up'},
    {type:'keyboard',value:5,action:'down'}, {type:'keyboard',value:5,action:'up'}
  ]);
});
