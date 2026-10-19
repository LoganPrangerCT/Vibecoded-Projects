import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../app/main.js',import.meta.url),'utf8');
const between=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const delay=value=>({type:'delay',value});
const macro=(id,value=20)=>({id,name:id,repeatCount:1,playbackMode:'once',macro:[delay(value)]});
class Node {
 constructor(tag,text='',className=''){Object.assign(this,{tag,textContent:text,className,children:[],value:'',listeners:{},classList:{add(){},remove(){},contains(){return false;}}});}
 append(...v){this.children.push(...v);} replaceChildren(...v){this.children=v;} after(){} setAttribute(){} focus(){}
 addEventListener(type,fn){this.listeners[type]=fn;} dispatchEvent(e){this.listeners[e.type]?.(e);} get options(){return this.children;}
 showModal(){this.open=true;} close(){this.open=false;}
}
function harness(){
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);};
 const controls=Array.from({length:6},()=>Object.fromEntries(['select','slot','mode','combo'].map(key=>[key,new Node('select')])));
 for(const c of controls){c.select.value='macro';c.slot.value='0';c.mode.value='0';}
 const writes=[],state={status:{connected:true,device:{path:'mouse-a',kind:'device',id:42,vid:1,pid:2,is24:false}},macros:[],events:[delay(20)],steps:[],selected:null};
 let pending=null,sequence=0;
 const context={state,$,buttonControls:controls,buttonNames:['Left','Right','Middle','Back','Forward','DPI'],dirtyButtons:new Set(),buttonDrafts:new Map(),buttonsOrigin:null,mappingActions:{},clone:structuredClone,same:(a,b)=>JSON.stringify(a)===JSON.stringify(b),renderStatus(){},refresh:async()=>{},
  element:(...v)=>new Node(...v),button:(text,onclick,className)=>Object.assign(new Node('button',text,className),{onclick}),
  Option:class{constructor(text,value){Object.assign(this,{text,value});}},Event:class{constructor(type){this.type=type;}},
  window:{R2Assignments:{create:()=>({render(){}})}},can:()=>true,crypto:{randomUUID:()=>`draft-${++sequence}`},
  renderMapping(index,mapping){controls[index].select.value=mapping?.[0]===9?'macro':'left';if(mapping?.[0]===9){controls[index].slot.value=String(mapping[2]);controls[index].mode.value=String(mapping[1]);}},renderMacros(){},renderSteps(){},setStepTypes(){},stopRecording(){},stopMacroPreview(){},toast(){},validateMacro:v=>v,guardMacro:async()=>true,resetMacro(){},selectMacro:async()=>{},
  api:async(path,method,data)=>{writes.push({path,method,data:structuredClone(data)});if(path==='/api/macros/preview')return{canonical:{repeatCount:data.macro.repeatCount,macro:data.macro.macro||[delay(20)]}};if(path==='/api/macros/prepare')return{slot:7,canonical:{repeatCount:data.macro.repeatCount,macro:data.macro.macro||[delay(20)]},verified:true,device:JSON.stringify(['mouse-a','device',42,'USB'])};if(path==='/api/macros/slots')return{device:JSON.stringify(['mouse-a','device',42,'USB']),slots:[]};if(path==='/api/macros/upload')return{verified:true};if(pending){const wait=pending;pending=null;await wait.promise;}return{};}
 };
 runInNewContext(`let performanceBusy=false,buttonRevision=0,macroRevision=0,macroEditor=0,macroSave=null;\n${between('async function mappingFor(index)',"for(const type of ['input','change'])")}\n${between('function draftMacro(){','function sanitizeSettings(')}\n${between('// Macro workspace assignment controls','async function initialize(){')}\nglobalThis.h={mapping:mappingFor,slot:macroOnboardSlot,valid:validMacroSlot,owner:macroForSlot,identity:macroContentIdentity,device:macroDeviceIdentity,remember:rememberMacroSlot,inspect:inspectMacroSlotAssociation,persist:persistMacros,draft:draftMacro,save:saveMacro,picks:assignmentMacroPicks,blocked:macroAssignmentBlocked,open:openMacroAssignment,close:closeMacroAssignment,edit:editMacroAssignment,sync:syncMacroAssignments,uploads:macroUploadSlots,change:()=>macroRevision++,changeButtons:()=>buttonRevision++,dirty:index=>{if(!dirtyButtons.size)buttonsOrigin=macroDeviceIdentity();buttonRevision++;dirtyButtons.add(index);},nextEditor:()=>macroEditor++,picker:macroPicker,action:assignmentMirrors.select.control,upload:assignmentUpload,back:backToMacroAssignments,pending:macroPendingAssignments,summary:slotSummary,labels:refreshVisibleSlotLabels,inventory:refreshMacroSlots};`,context);
 controls.forEach((c,index)=>Object.values(c).forEach(control=>control.addEventListener('input',()=>{context.h.dirty(index);context.h.sync();})));
 $('macro-name').value='New';$('macro-playback').value='once';$('macro-repeat').value='1';$('macro-slot').value='7';
 return{...context,context,controls,writes,h:context.h,hold(){let resolve;const promise=new Promise(done=>resolve=done);pending={promise};return resolve;}};
}

test('legacy/null/empty/boolean slots and imported provenance never authorize a named binding',async()=>{
 const e=harness();for(const value of [null,'',false,true,{},-1,20]){assert.equal(e.h.valid(value),null);assert.equal(e.h.slot({...macro('x'),onboardSlot:value}),null);}
 assert.equal(e.h.valid('7'),7);
 const original=macro('x');await e.h.remember(original,7,original,e.h.device(),1);const forged={...original,onboardUpload:e.h.uploads.get('x'),onboardSlot:7};
 await e.$('macro-file').onchange({target:{files:[{size:10,text:async()=>JSON.stringify({macros:[forged]})}],value:'file'}});
 assert.equal(e.state.macros.length,1);assert.equal(e.state.macros[0].onboardUpload,undefined);assert.equal(e.state.macros[0].onboardSlot,undefined);assert.equal(e.h.slot(e.state.macros[0]),null);
});

test('association tracks payload and device while names and playback preferences remain independent',async()=>{
 const e=harness(),a=macro('a');e.state.macros=[a];await e.h.remember(a,7,a,e.h.device(),4);
 assert.equal(e.h.slot(e.state.macros[0]),7);assert.equal(e.h.slot({...e.state.macros[0],name:'Renamed',playbackMode:'hold'}),7);
 assert.equal(e.h.slot({...e.state.macros[0],repeatCount:2}),null);assert.equal(e.h.slot({...e.state.macros[0],macro:[delay(21)]}),null);
 e.state.status.device.id=43;assert.equal(e.h.slot(e.state.macros[0]),null);e.state.status.device.id=42;assert.equal(e.h.slot(e.state.macros[0]),7);
 e.state.status.connected=false;assert.equal(e.h.slot(e.state.macros[0]),null);
});

test('receiver public status identity includes the paired mouse id and transport',async()=>{
 const e=harness(),a=macro('a');e.state.status.device={path:'receiver',kind:'receiver',id:100,connection:'2.4 GHz'};e.state.macros=[a];await e.h.remember(a,7,a,e.h.device(),1);
 assert.equal(e.h.slot(a),7);e.state.status.device.id=101;assert.equal(e.h.slot(a),null);e.state.status.device.id=100;e.state.status.device.connection='USB';assert.equal(e.h.slot(a),null);
 delete e.state.status.device.id;assert.equal(e.h.device(),null);
});

test('replacement retires previous owners immediately, duplicates are ambiguous, and read mismatch invalidates history',async()=>{
 const e=harness(),a=macro('a'),b=macro('b',40);e.state.macros=[a,b];await e.h.remember(a,7,a,e.h.device(),1);
 const release=e.hold(),upload=e.h.remember(b,7,b,e.h.device(),2);assert.equal(e.h.slot(e.state.macros[0]),null);release();await upload;
 assert.equal(e.state.macros[0].onboardUpload,undefined);assert.equal(e.h.owner(7).id,'b');
 e.state.macros.push({...e.state.macros[1],id:'duplicate'});assert.equal(e.h.owner(7).id,'b','session owner excludes copied metadata');
 await e.h.inspect(7,{decoded:{repeatCount:1,macro:[delay(99)]}},e.h.device());assert.equal(e.h.owner(7),null);
});

test('serialized metadata mutations preserve imports, edits, and deletion without resurrection',async()=>{
 const e=harness(),a=macro('a');e.state.macros=[a];const release=e.hold();
 const edit=e.h.persist(current=>current.map(item=>({...item,name:'Newest',macro:[delay(99)]})));
 await Promise.resolve();const upload=e.h.remember(a,7,a,e.h.device(),1),add=e.h.persist(current=>[...current,macro('imported')]),remove=e.h.persist(current=>current.filter(item=>item.id!=='a'));
 release();await Promise.all([edit,upload,add,remove]);assert.deepEqual(e.state.macros.map(m=>m.id),['imported']);
 await e.h.remember(a,8,a,e.h.device(),2);assert.deepEqual(e.state.macros.map(m=>m.id),['imported']);
 assert.ok(e.writes.filter(w=>w.path==='/api/macros').every(w=>Array.isArray(w.data.macros)));
});

test('upload before first save retains one draft id, and newer edits save as stale history',async()=>{
 const e=harness();const draft=e.h.draft();await e.$('upload-macro').onclick();assert.equal(e.h.draft().id,draft.id);
 await e.h.save();assert.equal(e.state.selected,draft.id);assert.equal(e.h.slot(e.state.macros[0]),7);
 e.state.events=[delay(90)];await e.h.save();assert.equal(e.state.macros.length,1);assert.equal(e.h.slot(e.state.macros[0]),null);
 e.h.nextEditor();e.state.selected=null;assert.notEqual(e.h.draft().id,draft.id);
});

test('named selection stages playback without asking for upload; raw selection remains optional',async()=>{
 const e=harness(),a={...macro('a'),playbackMode:'hold'},b=macro('b');e.state.macros=[a,b];await e.h.remember(a,7,a,e.h.device(),1);
 e.h.open(0);e.h.picker.control.value='a';e.h.picker.control.dispatchEvent({type:'input'});assert.equal(e.controls[0].slot.value,'7');assert.equal(e.controls[0].mode.value,'2');assert.equal(e.h.blocked(0),false);
 e.h.picker.control.value='b';e.h.picker.control.dispatchEvent({type:'input'});assert.equal(e.controls[0].slot.value,'7');assert.equal(e.h.picker.note.hidden,true);assert.equal(e.$('apply-buttons').disabled,false);
 e.h.close();e.h.open(1);e.h.open(0);e.h.edit('slot','7');assert.equal(e.h.picks.has(0),false);
 e.state.macros[0].playbackMode='again';e.h.picker.control.value='a';e.h.picker.control.dispatchEvent({type:'input'});assert.equal(e.controls[0].mode.value,'1');
 e.state.macros[0].playbackMode='count';e.h.picker.control.dispatchEvent({type:'input'});assert.equal(e.controls[0].mode.value,'0');
 assert.deepEqual(Array.from(await e.h.mapping(0)),[9,0,7,0]);assert.equal(e.writes.filter(w=>w.path==='/api/settings').length,0);
});

test('device switch while upload awaits verification does not create a named association',async()=>{
 const e=harness(),originalApi=e.context.api;let release;const pending=new Promise(resolve=>release=resolve);
 e.context.api=async(path,...args)=>{if(path==='/api/macros/prepare'){await pending;}return originalApi(path,...args);};
 const upload=e.$('upload-macro').onclick();await new Promise(resolve=>setImmediate(resolve));e.state.status.device.id=999;release();await upload;
 assert.equal(e.h.uploads.size,0);assert.equal(e.state.macros.length,0);assert.equal(e.$('upload-macro').disabled,false);
});

test('late slot reads preserve newer edits, another editor, another slot, and another mouse',async()=>{
 for(const change of [e=>e.h.change(),e=>e.h.nextEditor(),e=>e.$('macro-slot').value='8',e=>e.state.status.device.id=999]){
  const e=harness(),originalApi=e.context.api;let release;const pending=new Promise(resolve=>release=resolve);
  e.context.api=async(path,...args)=>path.startsWith('/api/macros/slot?')?(await pending,{decoded:{repeatCount:1,macro:[delay(99)]}}):originalApi(path,...args);
  const read=e.$('read-macro-slot').onclick();await new Promise(resolve=>setImmediate(resolve));change(e);e.state.events=[delay(77)];e.$('macro-name').value='Keep current';release();await read;
  assert.equal(e.state.events[0].value,77);assert.equal(e.$('macro-name').value,'Keep current');assert.equal(e.state.slotRead,undefined);
 }
});


test('visible Action lists every saved name, distinguishes duplicates, and hides preserved actions',async()=>{
 const e=harness();e.state.macros=[{...macro('a'),name:'Auto Clicker'},{...macro('b'),name:'Auto Clicker'}];
 e.controls[0].select.children=[{value:'',text:'Unknown · preserved'},{value:'left',text:'Left click'},{value:'macro',text:'Onboard macro'},{value:'custom',text:'Custom assignment · preserved'}];
 e.controls[0].select.value='custom';e.h.open(0);
 assert.deepEqual(Array.from(e.h.action.options,o=>[o.value,o.text]),[['custom','Keep current assignment'],['left','Left click'],['local:a','Auto Clicker'],['local:b','Auto Clicker (2)'],['macro','Other macro slot…']]);
 assert.equal(e.h.action.options[0].disabled,true);assert.equal(e.h.picker.wrapper.hidden,true);
 e.h.action.value='local:b';e.h.action.dispatchEvent({type:'input'});
 assert.equal(e.controls[0].select.value,'macro');assert.equal(e.h.action.value,'local:b');assert.equal(e.h.upload.hidden,true);assert.equal(e.$('apply-buttons').disabled,false);assert.equal(e.writes.length,0);
});

test('Upload macro opens the chosen saved editor through its draft guard and returns to its assignment',async()=>{
 const e=harness(),a=macro('a');e.state.macros=[a];e.h.open(2);e.h.edit('select','local:a');
 const selected=[];e.context.selectMacro=async id=>{selected.push(id);e.h.close();};
 e.context.guardMacro=async()=>false;await e.h.upload.onclick();assert.deepEqual(selected,[]);
 e.context.guardMacro=async()=>true;await e.h.upload.onclick();assert.deepEqual(selected,['a']);assert.equal(e.writes.length,0);
 e.h.back();assert.equal(e.h.action.value,'local:a');
});

test('verified upload completes only the unchanged pending named assignment',async()=>{
 const e=harness(),a={...macro('a'),playbackMode:'hold'};e.state.macros=[a];e.h.open(0);e.h.edit('select','local:a');
 const pending=e.h.pending('a',e.h.device());await e.h.remember(a,7,a,e.h.device(),1,pending);
 assert.equal(e.controls[0].slot.value,'7');assert.equal(e.controls[0].mode.value,'2');assert.equal(e.h.blocked(0),false);assert.deepEqual(Array.from(await e.h.mapping(0)),[9,2,7,0]);
 e.h.open(1);e.h.edit('select','local:a');const stale=e.h.pending('a',e.h.device());e.h.edit('mode','1');
 await e.h.remember(a,8,a,e.h.device(),2,stale);assert.equal(e.controls[1].slot.value,'7');assert.equal(e.controls[1].mode.value,'1');
 assert.equal(e.writes.filter(w=>w.path==='/api/settings'||w.path==='/api/macros/upload').length,0);
});


test('delayed deletion preserves a different editor and newer same-editor edits',async()=>{
 for(const otherEditor of [true,false]){
  const e=harness();e.state.macros=[macro('a'),macro('b')];e.state.selected='a';const resets=[];e.context.resetMacro=()=>resets.push(true);
  const release=e.hold(),deleting=e.$('delete-macro').onclick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(e.$('delete-macro').disabled,true);const double=e.$('delete-macro').onclick();
  if(otherEditor){e.state.selected='b';e.h.nextEditor();}else e.h.change();
  e.state.events=[delay(77)];e.$('macro-name').value='Keep edits';release();await Promise.all([deleting,double]);
  assert.deepEqual(e.state.macros.map(m=>m.id),['b']);assert.equal(resets.length,0);assert.equal(e.state.events[0].value,77);assert.equal(e.$('macro-name').value,'Keep edits');
  assert.equal(e.state.selected,otherEditor?'b':null);assert.equal(e.writes.filter(w=>w.path==='/api/macros').length,1);
 }
});

test('deleting a saved macro drops only its pending named drafts and restores actual mappings',async()=>{
 const e=harness();e.state.macros=[macro('a'),macro('b')];e.state.status.settings={keyMappings:[[1,0,240,0],[9,2,3,0],[1,0,241,0]]};
 e.h.open(0);e.h.edit('select','local:a');e.buttonDrafts.set(0,[9,0,7,0]);
 e.h.open(1);e.h.edit('select','local:b');e.h.open(2);e.h.edit('select','local:a');
 e.state.selected='a';e.context.resetMacro=()=>{e.state.selected=null;};await e.$('delete-macro').onclick();
 assert.equal(e.h.picks.has(0),false);assert.equal(e.h.picks.has(2),false);assert.equal(e.h.picks.get(1),'b');
 assert.deepEqual([...e.dirtyButtons],[1]);assert.equal(e.buttonDrafts.has(0),false);assert.equal(e.controls[0].select.value,'left');assert.equal(e.controls[2].select.value,'left');
 assert.equal(e.h.blocked(0),false);assert.equal(e.h.blocked(2),false);assert.equal(e.writes.some(w=>w.path==='/api/settings'||w.path==='/api/macros/upload'),false);
});

test('import rejects malformed and oversized JSON and safely retains markup-like names as text data',async()=>{
 const e=harness();let errors=[];e.context.toast=(message,error)=>{if(error)errors.push(message);};
 const file=()=>e.$('macro-file').onchange({target:{files:[{size:10,text:async()=>'{not json'}],value:'x'}});
 await file();assert.equal(e.state.macros.length,0);assert.match(errors.at(-1),/JSON|position|Unexpected/i);
 await e.$('macro-file').onchange({target:{files:[{size:1000001,text:async()=>''}],value:'x'}});
 assert.equal(e.state.macros.length,0);assert.match(errors.at(-1),/smaller than 1 MB/);
 const name='<img src=x onerror=alert(1)>';
 await e.$('macro-file').onchange({target:{files:[{size:10,text:async()=>JSON.stringify({name,repeatCount:1,steps:[{type:'delay',value:1}]})}],value:'x'}});
 assert.equal(e.state.macros[0].name,name);assert.equal(e.state.macros[0].onboardUpload,undefined);
 assert.match(source,/element\('span',macro\.name\)/,'library names are assigned through textContent by element()');
});

test('failed local metadata PUT after verified upload surfaces the PUT error but transiently keeps session association',async()=>{
 const e=harness(),a=macro('a');e.state.macros=[a];e.state.selected='a';e.$('macro-name').value='a';
 e.h.open(0);e.h.edit('select','local:a');
 const original=e.context.api;let uploadVerified=false,reported=[];
 e.context.toast=(message,error)=>{reported.push({message,error});};
 e.context.api=async(path,method,data)=>{
  if(path==='/api/macros/prepare'){uploadVerified=true;return original(path,method,data);}
  if(path==='/api/macros'&&method==='PUT')throw Error('disk full');
  return original(path,method,data);
 };
 await e.$('upload-macro').onclick();
 assert.equal(uploadVerified,true);assert.equal(reported.at(-1).message,'disk full');
 assert.equal(e.state.macros[0].onboardUpload,undefined,'persisted local record remains old');
 assert.equal(e.h.slot(e.state.macros[0]),7,'current-session cache still authorizes named association');
 assert.equal(e.writes.some(write=>write.path==='/api/macros/bind'),false,'a metadata error cannot automatically bind a button');
 e.h.picker.control.value='a';e.h.picker.control.dispatchEvent({type:'input'});
 assert.equal(e.h.blocked(0),false,'a fresh selection can use the verified upload held in the session cache');
});

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const choose=(e,index,id)=>{e.h.open(index);e.h.edit('select','local:'+id);};
const fullSlots=()=>Array.from({length:20},(_,index)=>({index,decoded:{repeatCount:1,macro:[delay(500+index)]},fingerprint:'slot-'+index,replaceable:true,reserved:true,protected:index===1}));

test('one Apply prepares a named macro once for two buttons and keeps each playback choice',async()=>{
 const e=harness(),a={...macro('a'),name:'Auto Clicker',playbackMode:'hold'};e.state.macros=[a];
 choose(e,0,'a');choose(e,1,'a');e.h.edit('mode','1');
 await e.$('apply-buttons').onclick();
 assert.equal(e.writes.filter(w=>w.path==='/api/macros/prepare').length,1);
 const bind=e.writes.find(w=>w.path==='/api/macros/bind');assert.ok(bind);
 assert.deepEqual(bind.data.buttonMappings,[{index:0,mapping:[9,2,7,0]},{index:1,mapping:[9,1,7,0]}]);
 assert.equal(bind.data.prepared.length,1);assert.equal(e.dirtyButtons.size,0);
 assert.equal(e.writes.some(w=>w.path==='/api/macros/slots'||w.path==='/api/macros/upload'),false);
 assert.match(e.$('macro-slot').options.find(o=>o.value==='7').text,/Auto Clicker/);
});

test('full storage is the only replacement prompt, cancel never binds or persists metadata',async()=>{
 const e=harness();e.state.macros=[macro('a'),{...macro('stored',500),name:'Stored clicker'}];choose(e,0,'a');
 const original=e.context.api;e.context.api=async(path,method,data)=>{if(path==='/api/macros/prepare'){e.writes.push({path,method,data:structuredClone(data)});return{needsSlot:true,device:e.h.device(),slots:fullSlots()};}return original(path,method,data);};
 const applying=e.$('apply-buttons').onclick();await tick();assert.equal(e.$('macro-slot-picker').open,true);
 assert.match(e.$('macro-slot-choices').children[0].children[1].textContent,/Slot 1.*Stored clicker/);
 assert.equal(e.$('macro-slot-choices').children[0].children[0].disabled,false);
 assert.equal(e.$('macro-slot-choices').children[1].children[0].disabled,true);
 e.$('macro-slot-picker-cancel').onclick();await applying;
 assert.equal(e.writes.length,1);assert.equal(e.dirtyButtons.size,1);
});

test('full storage replacement sends the observed fingerprint then verifies and binds',async()=>{
 const e=harness();e.state.macros=[macro('a')];choose(e,0,'a');const original=e.context.api;
 e.context.api=async(path,method,data)=>{if(path==='/api/macros/prepare'&&data.replaceSlot===undefined){e.writes.push({path,method,data:structuredClone(data)});return{needsSlot:true,device:e.h.device(),slots:fullSlots()};}return original(path,method,data);};
 const applying=e.$('apply-buttons').onclick();await tick();const radio=e.$('macro-slot-choices').children[0].children[0];radio.checked=true;radio.dispatchEvent({type:'change'});
 assert.equal(e.$('macro-slot-picker-use').disabled,false);e.$('macro-slot-picker-use').onclick();await applying;
 const prepares=e.writes.filter(w=>w.path==='/api/macros/prepare');assert.equal(prepares.length,2);assert.equal(prepares[1].data.replaceSlot,0);assert.equal(prepares[1].data.replaceFingerprint,'slot-0');
 assert.ok(e.writes.find(w=>w.path==='/api/macros/bind'));assert.equal(e.dirtyButtons.size,0);
});

test('preparing later macros protects the earlier resolved slot within the same Apply',async()=>{
 const e=harness();e.state.macros=[macro('a'),macro('b',40)];choose(e,0,'a');choose(e,1,'b');
 await e.$('apply-buttons').onclick();const prepares=e.writes.filter(w=>w.path==='/api/macros/prepare');
 assert.equal(prepares.length,2);assert.ok(prepares[1].data.reservedSlots.includes(7));
});

test('a prepared in-place macro update succeeds even when its button bytes are unchanged',async()=>{
 const e=harness();e.state.macros=[{...macro('a'),playbackMode:'hold'}];e.state.status.settings={keyMappings:[[9,2,7,0]]};choose(e,0,'a');
 const messages=[];e.context.toast=(message,error)=>messages.push({message,error});await e.$('apply-buttons').onclick();
 const bind=e.writes.find(w=>w.path==='/api/macros/bind');assert.ok(bind);assert.deepEqual(bind.data.buttonMappings,[]);assert.equal(bind.data.prepared.length,1);assert.equal(messages.at(-1).error,undefined);
});

test('late prepare responses cannot bind after draft or mouse changes or a wrong response identity',async()=>{
 for(const kind of ['draft','mouse','response']){
  const e=harness();e.state.macros=[macro('a')];choose(e,0,'a');const original=e.context.api;let release;const waiting=new Promise(resolve=>release=resolve);
  e.context.api=async(path,method,data)=>{if(path==='/api/macros/prepare'){await waiting;const result=await original(path,method,data);return kind==='response'?{...result,device:'other'}:result;}return original(path,method,data);};
  const applying=e.$('apply-buttons').onclick();await tick();if(kind==='draft')e.h.changeButtons();if(kind==='mouse')e.state.status.device.id=999;release();await applying;
  assert.equal(e.writes.some(w=>w.path==='/api/macros/bind'),false,kind);assert.equal(e.dirtyButtons.size,1);
 }
});

test('prepare or local metadata failure preserves assignments without binding',async()=>{
 for(const failingPath of ['/api/macros/prepare','/api/macros']){
  const e=harness();e.state.macros=[macro('a')];choose(e,0,'a');const original=e.context.api,errors=[];e.context.toast=(message,error)=>{if(error)errors.push(message);};
  e.context.api=(path,...args)=>path===failingPath?Promise.reject(Error('failed '+path)):original(path,...args);
  await e.$('apply-buttons').onclick();assert.equal(e.writes.some(w=>w.path==='/api/macros/bind'),false);assert.equal(e.dirtyButtons.size,1);assert.match(errors.at(-1),/failed/);
 }
});

test('fresh slot content invalidates cached names and another mouse never inherits the inventory',async()=>{
 const e=harness(),a={...macro('a'),name:'Auto Clicker'};e.state.macros=[a];await e.h.remember(a,7,a,e.h.device(),1);
 assert.equal(e.h.summary({index:7}),'Auto Clicker');
 assert.equal(e.h.summary({index:7,empty:true,erased:true}),'Empty');
 assert.doesNotMatch(e.h.summary({index:7,decoded:{repeatCount:1,macro:[delay(88)]}}),/Auto Clicker/);
 const original=e.context.api;e.context.api=(path,...args)=>path==='/api/macros/slots'?Promise.resolve({device:e.h.device(),slots:[{index:7,decoded:{repeatCount:1,macro:[delay(88)]}}]}):original(path,...args);
 await e.h.inventory();e.state.status.device.id=999;e.h.labels();assert.equal(e.$('macro-slot').options.length,20);assert.match(e.$('macro-slot').options[7].text,/Not read/);
});
