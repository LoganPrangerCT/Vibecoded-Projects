(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.R2Recorder = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const codes = {
    Enter:40, Escape:41, Backspace:42, Tab:43, Space:44, Minus:45, Equal:46,
    BracketLeft:47, BracketRight:48, Backslash:49, IntlHash:50, Semicolon:51,
    Quote:52, Backquote:53, Comma:54, Period:55, Slash:56, CapsLock:57,
    PrintScreen:70, ScrollLock:71, Pause:72, Insert:73, Home:74, PageUp:75,
    Delete:76, End:77, PageDown:78, ArrowRight:79, ArrowLeft:80, ArrowDown:81,
    ArrowUp:82, NumLock:83, NumpadDivide:84, NumpadMultiply:85, NumpadSubtract:86,
    NumpadAdd:87, NumpadEnter:88, NumpadDecimal:99, IntlBackslash:100,
    ContextMenu:101, NumpadEqual:103, ControlLeft:224, ShiftLeft:225, AltLeft:226,
    MetaLeft:227, ControlRight:228, ShiftRight:229, AltRight:230, MetaRight:231
  };
  for (let i=0;i<26;i++) codes['Key'+String.fromCharCode(65+i)]=4+i;
  for (let i=0;i<10;i++) codes['Digit'+((i+1)%10)]=30+i;
  for (let i=1;i<=24;i++) codes['F'+i]=i<=12 ? 57+i : 91+i;
  for (let i=1;i<=9;i++) codes['Numpad'+i]=88+i;
  codes.Numpad0=98;
  const buttons = ['left','middle','right','back','forward'];
  function codeToHid(event) { return codes[event.code]; }
  // Mirrors protocol.rs encode_macro_unpadded, including inline short delays.
  function encodedBytes(events) {
    let bytes=2, needsDelay=false;
    for (let i=0;i<events.length;i++) {
      const event=events[i];
      if (event.type==='delay') {
        if (!Number.isInteger(event.value) || event.value<0 || event.value>65535) throw Error('Invalid delay.');
        if (event.value===0) continue;
        bytes+=needsDelay ? 2 : 4;
        needsDelay=false;
        continue;
      }
      if (needsDelay) bytes+=2;
      if (event.type==='keyboard') {
        if (!Number.isInteger(event.value) || event.value<4 || event.value>239) throw Error('Invalid keyboard code.');
      } else if (event.type==='mouse_button') {
        if (!buttons.includes(event.value)) throw Error('Invalid mouse button.');
      } else if (event.type==='mouse_move') {
        if (![event.dx,event.dy].every(n=>Number.isInteger(n)&&n>=-128&&n<=127)) throw Error('Invalid movement.');
        bytes+=2;
      } else throw Error('Unsupported macro event.');
      if (event.type!=='mouse_move' && !['down','up'].includes(event.action)) throw Error('Invalid macro action.');
      bytes+=2;
      const next=events[i+1];
      if (next && next.type==='delay' && Number.isInteger(next.value) && next.value>0 && next.value<=127) {
        i++; needsDelay=false;
      } else needsDelay=true;
    }
    return bytes;
  }

  function create(options) {
    const zone=options.zone;
    const win=options.windowTarget || zone.ownerDocument.defaultView;
    const clock=options.clock || (() => performance.now());
    const getKeyCode=options.getKeyCode || codeToHid;
    const maxEvents=options.maxEvents === undefined ? 126 : options.maxEvents;
    const maxBytes=options.maxBytes === undefined ? 256 : options.maxBytes;
    const held=new Map(), listeners=[];
    let recording=false, destroyed=false, events=[], lastAt=null;
    function state(reason) {
      if (options.onState) options.onState({recording,reason,count:events.length,usedBytes:encodedBytes(events)});
    }
    function listen(target,type,fn) {
      target.addEventListener(type,fn,true);
      listeners.push(() => target.removeEventListener(type,fn,true));
    }
    function suppress(event) { event.preventDefault(); event.stopPropagation(); }
    function accepted(list) {
      return list.length<=maxEvents && encodedBytes(list)<=maxBytes && (!options.canAcceptEvents || options.canAcceptEvents(list));
    }
    function emit(list) {
      for (const event of list) {
        events.push(event);
        if (options.onEvent) options.onEvent({...event});
      }
    }
    function delays(now) {
      let ms=lastAt===null ? 0 : Math.max(0,Math.round(now-lastAt));
      const result=[];
      // A stalled/background timer must not allocate an unbounded array.
      while (ms>0 && result.length<=maxEvents) {
        const value=Math.min(65535,ms); result.push({type:'delay',value}); ms-=value;
      }
      return result;
    }
    function releases(map) {
      return Array.from(map.values(),event => ({...event,action:'up'}));
    }
    function stop(reason='stopped') {
      if (!recording) return;
      const now=clock(), ups=releases(held), timed=[...delays(now),...ups];
      recording=false;
      // Down events reserve room for these releases, even at the storage limit.
      if (ups.length) emit(accepted([...events,...timed]) ? timed : ups);
      held.clear(); lastAt=null; state(reason);
    }
    function transition(id,event) {
      const next=new Map(held);
      if (event.action==='down') {
        if (next.has(id)) return;
        next.set(id,event);
      } else {
        if (!next.has(id)) return;
        next.delete(id);
      }
      const now=clock(), additions=[...delays(now),event];
      // Reserve an up for each held input. Timing is retained whenever capacity permits.
      if (!accepted([...events,...additions,...releases(next)])) { stop('limit'); return; }
      held.clear(); for (const [key,value] of next) held.set(key,value);
      lastAt=now; emit(additions); state('event');
    }
    listen(zone,'keydown',event => {
      if (!recording) return;
      suppress(event);
      if (event.code==='Escape' || event.key==='Escape') { stop('escape'); return; }
      if (event.repeat) return;
      const value=getKeyCode(event);
      if (!Number.isInteger(value) || value<4 || value>239) return;
      transition('key:'+value,{type:'keyboard',value,action:'down'});
    });
    listen(win,'keyup',event => {
      if (!recording) return;
      const value=getKeyCode(event);
      if (!held.has('key:'+value)) return;
      suppress(event); transition('key:'+value,{type:'keyboard',value,action:'up'});
    });
    listen(zone,'mousedown',event => {
      if (!recording) return;
      suppress(event); zone.focus({preventScroll:true});
      const value=buttons[event.button];
      if (value) transition('mouse:'+value,{type:'mouse_button',value,action:'down'});
    });
    listen(win,'mouseup',event => {
      if (!recording) return;
      const value=buttons[event.button];
      if (!held.has('mouse:'+value)) return;
      suppress(event); transition('mouse:'+value,{type:'mouse_button',value,action:'up'});
    });
    for (const type of ['contextmenu','auxclick','click']) {
      listen(zone,type,event => { if (recording) suppress(event); });
    }
    for (const type of ['pointercancel','lostpointercapture']) {
      listen(zone,type,() => { if (recording) stop('cancelled'); });
    }
    listen(win,'blur',event => {
      // Capture also sees descendant element blur; only leaving the window stops.
      if (event.target===win) stop('window-blur');
    });
    return {
      start(config={}) {
        if (destroyed) throw Error('Recorder has been destroyed.');
        if (recording) return;
        const initial=(config.events || []).map(event => ({...event}));
        if (!accepted(initial)) throw Error('This sequence exceeds the recording capacity.');
        events=initial; held.clear(); lastAt=null; recording=true;
        zone.focus({preventScroll:true}); state('started');
      },
      stop,
      destroy() { stop('destroyed'); listeners.forEach(remove => remove()); destroyed=true; },
      getEvents() { return events.map(event => ({...event})); },
      isRecording() { return recording; }
    };
  }
  return {create,codeToHid,encodedBytes};
});
