import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source=readFileSync(new URL('../app/main.js',import.meta.url),'utf8');
class Node {
 constructor(tag,text,className=''){Object.assign(this,{tag,textContent:text,className,children:[],attributes:{},listeners:{},scrollLeft:0});}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;this.scrollLeft=0;}
 setAttribute(key,value){this.attributes[key]=value;}
 addEventListener(key,callback){this.listeners[key]=callback;}
 querySelector(){return null;}
 get firstChild(){return this.children[0];}
 dataset={};
}
function editor(events,legacy=false){
 const root=new Node('div'),inspector=new Node('div');let revisions=0;
 const context={state:{events:legacy?null:events,steps:legacy?events:[]},previewEvents:null,stopMacroPreview(){},macroInspector:inspector,macroEditor:0,keyNames:{4:'A',5:'B'},mouseButtons:['left','right'],
  $:()=>root,element:(...args)=>new Node(...args),Option:class {constructor(text,value){Object.assign(this,{text,value});}},
  button:(text,onclick,className)=>Object.assign(new Node('button',text,className),{onclick}),
  macroChanged:()=>revisions++,empty:(target,text)=>target.append(new Node('div',text)),
 };
 Node.prototype.add=function(option){this.append(option);};
 const input=source.slice(source.indexOf('function valueInput('),source.indexOf('const macroInspector='));
 const render=source.slice(source.indexOf('function eventTitle('),source.indexOf('function bounded('));
 runInNewContext('let selectedEvent=-1,timelineEditor=-1;\n'+input+render+'\nglobalThis.render=renderSteps;globalThis.select=selectEvent;',context);
 context.render();
 const all=node=>[node,...(node.children||[]).flatMap(all)];
 return {context,root,inspector,events,all,find:(node,label)=>all(node).find(el=>el.attributes?.['aria-label']===label),revisions:()=>revisions};
}

test('timeline retains press, delay, and release as distinct editable events',()=>{
 const events=[{type:'keyboard',value:4,action:'down'},{type:'delay',value:25},{type:'keyboard',value:4,action:'up'}];
 const e=editor(events);
 assert.ok(e.find(e.root,'Event 1: Press A'));
 assert.ok(e.find(e.root,'Event 3: Release A'));
 const delay=e.find(e.root,'Step 2 value in milliseconds');
 delay.value='67';delay.listeners.input();
 assert.equal(events[1].value,67);
 assert.equal(e.revisions(),1);
 assert.deepEqual(events[0],{type:'keyboard',value:4,action:'down'});
 assert.deepEqual(events[2],{type:'keyboard',value:4,action:'up'});
});

test('inspector editing, reordering, and deletion preserve exact event semantics',()=>{
 const events=[{type:'keyboard',value:4,action:'down'},{type:'delay',value:25},{type:'keyboard',value:4,action:'up'}];
 const e=editor(events);e.context.select(2);
 const key=e.find(e.inspector,'Event 3 key');key.value='5';key.onchange();
 assert.ok(e.find(e.root,'Event 3: Release B'));
 e.find(e.inspector,'Move step 3 earlier').onclick();
 assert.deepEqual(events.map(step=>step.type),['keyboard','keyboard','delay']);
 assert.deepEqual(events[1],{type:'keyboard',value:5,action:'up'});
 e.find(e.inspector,'Delete step 2').onclick();
 assert.deepEqual(events,[{type:'keyboard',value:4,action:'down'},{type:'delay',value:25}]);
});

test('legacy combos remain taps and committed edits refresh the keycap',()=>{
 const events=[{type:'key',value:'Ctrl+C'}],e=editor(events,true);e.context.select(0);
 assert.ok(e.find(e.root,'Event 1: Ctrl+C tap'));
 const input=e.find(e.inspector,'Step 1 value');input.value='Ctrl+V';input.listeners.input();
 assert.equal(events[0].value,'Ctrl+V');
 assert.ok(e.find(e.root,'Event 1: Ctrl+C tap'),'typing keeps the field mounted');
 input.listeners.change();assert.ok(e.find(e.root,'Event 1: Ctrl+V tap'));
 assert.equal(events.length,1);
});

test('rerender keeps horizontal position and movement edits refresh on commit',()=>{
 const events=[{type:'mouse_move',dx:2,dy:-3}],e=editor(events);e.context.select(0);
 e.root.scrollLeft=180;e.context.render();assert.equal(e.root.scrollLeft,180);
 const input=e.find(e.inspector,'Event 1 X movement');input.value='8';input.listeners.input();input.listeners.change();
 assert.deepEqual(events[0],{type:'mouse_move',dx:8,dy:-3});
 assert.ok(e.find(e.root,'Event 1: 8, -3'));
});
