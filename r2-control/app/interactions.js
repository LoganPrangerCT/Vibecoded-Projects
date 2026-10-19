/* Small, local interactions. Device changes remain behind the existing Apply actions. */
(() => {
 'use strict';
 const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
 const finePointer=window.matchMedia('(hover: hover) and (pointer: fine)');
 // The photo follows pointer position by just a few pixels; controls never move.
 const visual=document.querySelector('#overview .device-visual');
 const photo=visual?.querySelector('.device-photo');
 if(visual&&photo){
  let frame=0,x=0,y=0;
  const draw=()=>{
   frame=0;
   photo.style.setProperty('--mouse-shift-x',x+'px');
   photo.style.setProperty('--mouse-shift-y',y+'px');
  };
  const schedule=()=>{if(!frame)frame=window.requestAnimationFrame(draw);};
  const reset=()=>{x=0;y=0;schedule();};
  visual.addEventListener('pointermove',event=>{
   if(reducedMotion.matches||!finePointer.matches||event.pointerType==='touch')return;
   const rect=visual.getBoundingClientRect();
   x=((event.clientX-rect.left)/rect.width-.5)*8;
   y=((event.clientY-rect.top)/rect.height-.5)*6;
   schedule();
  });
  visual.addEventListener('pointerleave',reset);
  window.addEventListener('blur',reset);
  reducedMotion.addEventListener('change',reset);
  finePointer.addEventListener('change',reset);
 }
})();
