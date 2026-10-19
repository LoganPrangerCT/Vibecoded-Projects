import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source=readFileSync(new URL('../app/main.js',import.meta.url),'utf8');
const between=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
class Node {
 constructor(tag='div',text='',className=''){Object.assign(this,{tag,textContent:text,className,children:[],value:'',listeners:{},hidden:false});const classes=new Set();this.classList={add:(...v)=>v.forEach(x=>classes.add(x)),remove:(...v)=>v.forEach(x=>classes.delete(x)),contains:v=>classes.has(v)};}
 append(...v){this.children.push(...v);}
 replaceChildren(...v){this.children=v;}
 after(node){this.afterNode=node;}
 setAttribute(){}
 addEventListener(type,fn){this.listeners[type]=fn;}
 dispatchEvent(event){this.listeners[event.type]?.(event);}
 focus(){this.focused=true;}
 get options(){return this.children;}
}
function workspace(){
 const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id);},writes=[],renders=[],messages=[],dirtyButtons=new Set();
 const element=(...args)=>new Node(...args),button=(text,onclick,classes)=>Object.assign(element('button',text,classes),{onclick});
 const controls=Array.from({length:6},()=>Object.fromEntries(['select','slot','mode','combo'].map(key=>[key,new Node(key==='combo'?'input':'select')])));
 for(const c of controls){c.select.append({value:'left',text:'Left click'},{value:'right',text:'Right click'},{value:'macro',text:'Onboard macro'},{value:'combo',text:'Keyboard combo'});c.select.value='left';c.slot.append({value:'0',text:'Slot 1'},{value:'7',text:'Slot 8'});c.slot.value='0';c.mode.append({value:'0',text:'Repeat count'});c.mode.value='0';}
 const state={status:{connected:true,device:{id:7,path:'/device/a',kind:'device',connection:'USB'},settings:{keyMappings:controls.map(()=>[1,0,240,0])}},selected:null,macroDirty:false,steps:[],events:[],macros:[{id:'a',name:'Rapid Fire',macro:[{type:'delay',value:20}]},{id:'b',name:'Copy',steps:[{type:'key',value:'Ctrl+C'}]}]};
 const context={$,element,button,state,buttonControls:controls,buttonNames:['Left','Right','Middle','Forward','Back','DPI'],dirtyButtons,buttonDrafts:new Map(),buttonsOrigin:null,macroDeviceIdentity:()=>state.status.connected?'device-a':null,mappingActions:{left:[1,0,240,0],right:[1,0,241,0]},
  Event:class{constructor(type){this.type=type;}},Option:class{constructor(text,value){Object.assign(this,{text,value});}},window:{R2Assignments:{create({root,onSelect}){root.replaceChildren(new Node());return{render:(...args)=>renders.push(args),onSelect};}}},
  clone:structuredClone,same:(a,b)=>JSON.stringify(a)===JSON.stringify(b),can:()=>state.status.connected,empty:(root,text)=>root.append(element('div',text)),
  stopMacroPreview(){},stopRecording(){},expandEditor:new Node(),guardMacro:async()=>false,renderSteps(){},setStepTypes(){},renderMacroState(){},toast(message){messages.push(message);},refresh:async()=>{},api:async(...args)=>{writes.push(args);return{};},renderStatus:()=>context.sync(),syncButtons:()=>{controls.forEach(c=>c.select.value='left');context.sync();},
 };
 runInNewContext(`let performanceBusy=false,buttonRevision=0,macroEditor=0;\n${between('function resetMacroAssignmentDraftState()','function bumpAssignmentChoice(index)')}\n${between('async function mappingFor(index)',"for(const type of ['input','change'])")}\n${between('function renderMacros(){','function valueInput(')}\n${between('// Macro workspace assignment controls','async function initialize(){')}\nglobalThis.open=openMacroAssignment;globalThis.close=closeMacroAssignment;globalThis.back=backToMacroAssignments;globalThis.edit=openMacroEditor;globalThis.render=renderMacros;globalThis.select=selectMacro;globalThis.sync=syncMacroAssignments;globalThis.busy=value=>{performanceBusy=value;syncMacroAssignments();};globalThis.dirty=index=>{if(!dirtyButtons.size)buttonsOrigin='["/device/a","device",7,"USB"]';buttonRevision++;dirtyButtons.add(index);syncMacroAssignments();};`,context);
 controls.forEach((c,index)=>Object.values(c).forEach(control=>control.addEventListener('input',()=>context.dirty(index))));
 return{context,$,state,controls,writes,renders,messages,dirtyButtons};
}
test('macro landing hides timeline, searches library, and opens a selected sequence',async()=>{
 const e=workspace();assert.equal(e.$('macros').classList.contains('macro-editing'),false);
 e.$('macro-search').value='fire';e.context.render();assert.equal(e.$('macro-list').children.length,1);assert.equal(e.$('macro-list').children[0].children[0].textContent,'Rapid Fire');
 await e.context.select('a',true);assert.equal(e.$('macros').classList.contains('macro-editing'),true);assert.equal(e.state.events[0].value,20);
 e.context.back();assert.equal(e.$('macro-list').afterNode.hidden,true,'saved library entry already resumes its editor');
});
test('back and resume preserve unsaved draft; selecting current macro also resumes it',async()=>{
 const e=workspace();await e.context.select('a',true);e.state.events[0].value=91;e.state.macroDirty=true;e.$('macro-name').value='Edited';
 e.context.back();assert.equal(e.$('macros').classList.contains('macro-editing'),false);assert.equal(e.$('macro-list').afterNode.hidden,false);
 await e.context.select('a');assert.equal(e.state.events[0].value,91);assert.equal(e.state.macroDirty,true);assert.equal(e.$('macro-name').value,'Edited');
 e.context.back();e.$('macro-list').afterNode.onclick();assert.equal(e.$('macros').classList.contains('macro-editing'),true);assert.equal(e.state.events[0].value,91);
});
test('inline assignment panel stays attached and edits existing drafts without writing until Apply',async()=>{
 const e=workspace();assert.ok(e.$('macro-assignment-scene').children.some(node=>node.id==='macro-assignment-editor'));
 e.context.open(1);const action=e.$('macro-assignment-scene').children[1].children[1].children[0].children[1];
 action.value='right';action.dispatchEvent({type:'input'});assert.equal(e.controls[1].select.value,'right');assert.ok(e.dirtyButtons.has(1));assert.equal(e.writes.length,0);
 e.context.close();assert.ok(e.dirtyButtons.has(1));e.context.open(1);assert.equal(action.value,'right');
 const apply=e.$('macro-assignment-scene').children[1].children[2].children[2];apply.onclick();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(e.writes.length,1,JSON.stringify(e.messages));assert.equal(e.writes[0][0],'/api/settings');assert.equal(JSON.stringify(e.writes[0][2]),'{"device":"[\\\"/device/a\\\",\\\"device\\\",7,\\\"USB\\\"]","buttonMappings":[{"index":1,"mapping":[1,0,241,0]}]}');
});
test('assignment controls disable offline and busy and Revert uses shared draft state',()=>{
 const e=workspace();e.context.open(0);const panel=e.$('macro-assignment-scene').children[1],action=panel.children[1].children[0].children[1];
 e.context.busy(true);assert.equal(action.disabled,true);action.value='right';action.dispatchEvent({type:'input'});assert.equal(e.controls[0].select.value,'left');
 e.context.busy(false);action.dispatchEvent({type:'input'});assert.equal(e.dirtyButtons.size,1);
 panel.children[2].children[1].onclick();assert.equal(e.dirtyButtons.size,0);assert.equal(e.writes.length,0);
 e.state.status.connected=false;e.context.sync();assert.equal(action.disabled,true);
});


test('one Button mapping navigation owns assignments and legacy hashes redirect into it',()=>{
 const html=readFileSync(new URL('../app/index.html',import.meta.url),'utf8');
 const navigation=[...html.matchAll(/<button data-view="([^"]+)"/g)].map(match=>match[1]);
 assert.deepEqual(navigation,['overview','performance','macros','profiles','diagnostics']);
 assert.match(html,/<button data-view="macros" title="Button mapping" aria-label="Button mapping"/);
 assert.doesNotMatch(html,/<section[^>]*id="buttons"/);
 assert.match(html,/<div id="button-rows" hidden aria-hidden="true"><\/div>/);
 assert.match(html,/<div class="mapping-toolbar">[\s\S]*?id="revert-buttons"[\s\S]*?id="apply-buttons"[\s\S]*?<\/div>/);
 const views=navigation.map(id=>({id,classList:{toggle(name,active){this.active=active;}}}));
 const nav=navigation.map(view=>({dataset:{view},attributes:{},setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},classList:{toggle(name,active){this.active=active;}}}));
 const crumb={};let hash;
 runInNewContext(`${between('const labels=','const dirtyButtons=')}\n${between('function navigate(view)',"document.querySelectorAll('[data-view]')")}\nnavigate('buttons');`,{
  document:{querySelectorAll:selector=>selector==='.view'?views:nav},$:()=>crumb,history:{replaceState(a,b,value){hash=value;}},window:{scrollTo(){}},stopMacroPreview(){},
 });
 assert.equal(hash,'#macros');assert.equal(crumb.textContent,'BUTTON MAPPING');
 assert.equal(views.find(view=>view.id==='macros').classList.active,true);
 assert.equal(nav.find(item=>item.dataset.view==='macros').attributes['aria-current'],'page');assert.equal(nav.filter(item=>item.attributes['aria-current']==='page').length,1);
});

test('workspace toolbar applies and reverts group drafts after the inline panel closes',async()=>{
 const e=workspace();e.context.open(1);e.context.dirty(1);e.controls[1].select.value='right';e.context.close();
 assert.equal(e.$('apply-buttons').disabled,false);assert.equal(e.$('revert-buttons').disabled,false);
 await e.$('apply-buttons').onclick();assert.equal(e.writes.length,1);assert.equal(e.dirtyButtons.size,0);
 e.context.dirty(0);e.context.close();e.context.busy(true);
 assert.equal(e.$('apply-buttons').disabled,true);assert.equal(e.$('revert-buttons').disabled,true);
 e.context.busy(false);e.$('revert-buttons').onclick();assert.equal(e.dirtyButtons.size,0);
});

test('neutral surfaces and orange accents remain consistent across workspace styles',()=>{
 const style=readFileSync(new URL('../app/style.css',import.meta.url),'utf8');
 assert.match(style,/--bg:#090909;--panel:#111111;--panel2:#171717/);
 assert.match(style,/--accent:#ff8356;--accent-soft:#1b1b1b/);
 for(const file of ['style.css','macro.css','assignments.css','interactions.css']){
  const css=readFileSync(new URL('../app/'+file,import.meta.url),'utf8');
  for(const declaration of css.matchAll(/(?:background|background-color):([^;}]+)/g)){
   for(const color of declaration[1].matchAll(/#([0-9a-f]{6})(?![0-9a-f])/gi)){
    const rgb=[0,2,4].map(index=>parseInt(color[1].slice(index,index+2),16));
    if(Math.max(...rgb)<150)assert.equal(new Set(rgb).size,1,file+' has a tinted dark surface '+color[0]);
   }
  }
 }
});


test('unified assignment drafts retain defaults, custom bytes, combo compilation and onboard modes',async()=>{
 const writes=[],context={state:{status:{connected:true,settings:{keyMappings:[[37,254,91,17],[1,0,241,0]]}}},macroDeviceIdentity:()=> 'device-a',buttonsOrigin:'device-a',dirtyButtons:new Set([0,1]),buttonDrafts:new Map(),clone:structuredClone,same:(a,b)=>JSON.stringify(a)===JSON.stringify(b),buttonNames:['Left','Right'],buttonRevision:0,api:async(...args)=>{writes.push(args);return{mapping:[0,3,22,0]};}};
 runInNewContext(`${between('const mappingActions=','for(let slot=')}\n${between('async function mappingFor(index)',"$('apply-buttons').onclick")}\nglobalThis.controls=buttonControls;globalThis.actions=mappingActions;globalThis.mapping=mappingFor;globalThis.changes=changedButtonMappings;`,context);
 const c={select:{value:'custom'},slot:{value:'19'},mode:{value:'0'},combo:{value:'Ctrl+Shift+S'}};
 context.controls.push(c,{select:{value:'dpi'}});
 assert.equal(JSON.stringify(await context.changes()),'[{"index":1,"mapping":[20,0,0,0]}]','unknown bytes stay untouched when another button changes');
 for(const [action,bytes] of Object.entries({left:[1,0,240,0],right:[1,0,241,0],middle:[1,0,242,0],back:[1,0,243,0],forward:[1,0,244,0],dpi:[20,0,0,0],disabled:[0,0,0,0]})){
  c.select.value=action;assert.equal(JSON.stringify(await context.mapping(0)),JSON.stringify(bytes));
 }
 c.select.value='macro';for(const mode of [0,1,2]){c.mode.value=String(mode);assert.equal(JSON.stringify(await context.mapping(0)),JSON.stringify([9,mode,19,0]));}
 c.select.value='combo';assert.equal(JSON.stringify(await context.mapping(0)),'[0,3,22,0]');assert.equal(writes[0][0],'/api/key/compile');assert.equal(writes[0][2].combo,'Ctrl+Shift+S');
});
