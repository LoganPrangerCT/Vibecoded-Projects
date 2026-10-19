(function(root,factory){
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.R2ManualEvents=api;
})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 function create({read,compile,commit}){
  let pending=null;
  function append(input){
   if(pending)return pending;
   const snapshot=structuredClone(read());
   const source=snapshot.events===null?{steps:snapshot.steps}:{macro:snapshot.events};
   pending=(async()=>{
    let additions;
    if(input.type==='key'){
     if(typeof input.value!=='string'||!input.value.trim())throw Error('Enter a key or keyboard combo.');
     additions=(await compile({repeatCount:1,steps:[{type:'key',value:input.value.trim()}]})).canonical.macro;
    }else if(input.type==='click'){
     if(!['left','right','middle','back','forward'].includes(input.value))throw Error('Choose a mouse button.');
     additions=['down','up'].map(action=>({type:'mouse_button',value:input.value,action}));
    }else if(input.type==='delay'){
     const value=Number(input.value);
     if(input.value===''||!Number.isInteger(value)||value<1||value>65535)throw Error('Delay must be 1–65535 ms.');
     additions=[{type:'delay',value}];
    }else if(input.type==='mouse_move'){
     const dx=Number(input.value),dy=Number(input.dy);
     if(input.value===''||input.dy===''||![dx,dy].every(n=>Number.isInteger(n)&&n>=-128&&n<=127))throw Error('Movement must be −128–127 on each axis.');
     additions=[{type:'mouse_move',dx,dy}];
    }else throw Error('Choose an event type.');
    const base=source.macro??(source.steps.length?(await compile({repeatCount:1,...source})).canonical.macro:[]);
    const events=[...base,...additions];
    if(events.length>126)throw Error('A sequence supports up to 126 events.');
    const checked=await compile({repeatCount:1,macro:events});
    const current=read();
    if(current.editor!==snapshot.editor||current.revision!==snapshot.revision)throw Error('The sequence changed. Add the event again.');
    commit(structuredClone(checked.canonical.macro));
    return checked.canonical.macro;
   })();
   const task=pending;
   task.then(()=>{if(pending===task)pending=null;},()=>{if(pending===task)pending=null;});
   return task;
  }
  return {append};
 }
 return {create};
});
