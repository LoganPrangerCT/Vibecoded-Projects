import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

test('R2B side-button callouts preserve original physical matrix indices',()=>{
 const main=readFileSync(new URL('../app/main.js',import.meta.url),'utf8');
 const context={};
 runInNewContext(main.match(/const buttonNames=\[[^;]+;/)[0]+main.match(/const mappingActions=\{[^;]+;/)[0]+'globalThis.names=buttonNames;globalThis.actions=mappingActions;',context);
 // Shipped C3r overrides defaultMatrix=P3r (UTF8 offsets12818346/12816440).
 // Its first six entries are 240,241,242,244,243,DPI20. Vj names244Forward243Back.
 const originalP3r=[[1,0,240,0],[1,0,241,0],[1,0,242,0],[1,0,244,0],[1,0,243,0],[20,0,0,0]];
 assert.equal(context.names[3],'Forward button');
 assert.equal(context.names[4],'Back button');
 assert.equal(JSON.stringify(context.actions.forward),JSON.stringify(originalP3r[3]));
 assert.equal(JSON.stringify(context.actions.back),JSON.stringify(originalP3r[4]));
 class Element{
  constructor(tag){Object.assign(this,{tag,children:[],dataset:{},style:{},listeners:{},attributes:{},classList:{add(){},toggle(){}}});}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(key,value){this.attributes[key]=String(value);}
  addEventListener(type,callback){this.listeners[type]=callback;}
 }
 const window={},document={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)};
 runInNewContext(readFileSync(new URL('../app/assignments.js',import.meta.url),'utf8'),{window,document});
 const root=new Element('root'),selected=[];
 window.R2Assignments.create({root,onSelect:index=>selected.push(index)});
 const diagram=root.children[1],callouts=diagram.children.filter(node=>node.tag==='button');
 const leaders=diagram.children[1].children;
 for(const [index,name,y] of [[3,'Forward',194],[4,'Back',251]]){
  assert.match(callouts[index].attributes['aria-label'],new RegExp('^'+name+':'));
  assert.equal(callouts[index].dataset.assignmentIndex,String(index));
  assert.equal(leaders[index].children[1].attributes.cy,String(y));
  callouts[index].listeners.click();
 }
 assert.deepEqual(selected,[3,4]);
});
