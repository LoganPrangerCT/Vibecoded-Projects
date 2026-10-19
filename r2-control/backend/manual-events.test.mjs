import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const context={module:{exports:{}},structuredClone};
runInNewContext(readFileSync(new URL('../app/manual-events.js',import.meta.url),'utf8'),context);
const {create}=context.module.exports;
const key=[{type:'keyboard',value:4,action:'down'},{type:'keyboard',value:4,action:'up'}];
function harness(events=[]){
 const state={editor:1,revision:1,events,steps:[]},calls=[],commits=[];
 const compile=async macro=>{calls.push(structuredClone(macro));if(macro.steps)return{canonical:{macro:key}};return{canonical:macro};};
 const builder=create({read:()=>state,compile:macro=>context.compile(macro),commit:next=>{commits.push(next);state.events=next;state.revision++;}});
 const context={state,calls,commits,compile,builder};return context;
}
test('manual keyboard tap uses the Rust compiler and preserves earlier timing',async()=>{
 const e=harness([{type:'delay',value:40}]);await e.builder.append({type:'key',value:' A '});
 assert.deepEqual(e.calls[0],{repeatCount:1,steps:[{type:'key',value:'A'}]});
 assert.deepEqual(e.state.events,[{type:'delay',value:40},...key]);assert.equal(e.commits.length,1);
});
test('manual mouse tap, delay and signed movement use canonical events',async()=>{
 const e=harness();await e.builder.append({type:'click',value:'left'});await e.builder.append({type:'delay',value:'128'});await e.builder.append({type:'mouse_move',value:'-128',dy:'127'});
 assert.deepEqual(e.state.events,[{type:'mouse_button',value:'left',action:'down'},{type:'mouse_button',value:'left',action:'up'},{type:'delay',value:128},{type:'mouse_move',dx:-128,dy:127}]);
});
test('legacy steps are compiled before appending without losing content',async()=>{
 const e=harness(null);e.state.steps=[{type:'key',value:'A'}];await e.builder.append({type:'delay',value:10});
 assert.deepEqual(e.calls[0],{repeatCount:1,steps:[{type:'key',value:'A'}]});assert.deepEqual(e.state.events,[...key,{type:'delay',value:10}]);
});
test('invalid and over-capacity events do not replace the editor',async()=>{
 const e=harness();for(const input of [{type:'key',value:''},{type:'click',value:'missing'},{type:'delay',value:''},{type:'delay',value:'0'},{type:'mouse_move',value:'128',dy:'0'}])await assert.rejects(e.builder.append(input));
 e.compile=async()=>{throw Error('Macro exceeds 256 bytes');};await assert.rejects(e.builder.append({type:'delay',value:20}),/256/);assert.equal(e.commits.length,0);
});
test('a changed or replaced editor rejects a late compilation',async()=>{
 for(const field of ['revision','editor']){
  const e=harness();let complete;e.compile=macro=>new Promise(resolve=>{complete=()=>resolve({canonical:macro});});
  const task=e.builder.append({type:'delay',value:20});e.state[field]++;complete();await assert.rejects(task,/sequence changed/);assert.equal(e.commits.length,0);
 }
});
test('double submission shares a pending append and can retry after failure',async()=>{
 const e=harness();let complete;e.compile=macro=>new Promise(resolve=>{complete=()=>resolve({canonical:macro});});
 const first=e.builder.append({type:'delay',value:10}),second=e.builder.append({type:'delay',value:10});assert.equal(first,second);complete();await first;assert.equal(e.commits.length,1);
 e.compile=async()=>{throw Error('compile failed');};await assert.rejects(e.builder.append({type:'delay',value:20}));
 e.compile=async macro=>({canonical:macro});await e.builder.append({type:'delay',value:30});assert.equal(e.commits.length,2);
});
