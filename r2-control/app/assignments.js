'use strict';
// Presentation only: choosing a physical control delegates to the real editor.
window.R2Assignments=(()=>{
 const controls=[
  {name:'Left click',side:'left',y:110,path:'M 358 118 L 304 110 L 204 110',anchor:[358,118]},
  {name:'Right click',side:'right',y:250,path:'M 453 123 L 549 250 L 596 250',anchor:[453,123]},
  {name:'Middle click',side:'right',y:110,path:'M 400 112 L 533 110 L 596 110',anchor:[400,112]},
  {name:'Forward',side:'left',y:250,path:'M 290 194 L 251 250 L 204 250',anchor:[290,194]},
  {name:'Back',side:'left',y:390,path:'M 290 251 L 251 390 L 204 390',anchor:[290,251]},
  // DPI is on the underside. Its endpoint is a separate caption below the
  // photograph, never an invented physical position on the visible shell.
  {name:'DPI',side:'right',y:390,path:'M 441 515 L 552 515 L 552 390 L 596 390',anchor:[441,515],underside:true}
 ];
 const svgNS='http://www.w3.org/2000/svg';
 function create({root,onSelect=()=>{}}){
  if(!root)throw Error('An assignment scene root is required.');
  const heading=document.createElement('div');heading.className='assignment-scene-heading';
  const title=document.createElement('h2');title.textContent='R2';
  const subtitle=document.createElement('p');subtitle.textContent='Assignments';heading.append(title,subtitle);
  const diagram=document.createElement('div');diagram.className='assignment-diagram';
  const photo=document.createElement('img');photo.className='assignment-photo';photo.src='assets/r2-mouse.png';photo.alt='Attack Shark R2, top view';photo.draggable=false;
  const svg=document.createElementNS(svgNS,'svg');svg.classList.add('assignment-leaders');svg.setAttribute('viewBox','0 0 800 560');svg.setAttribute('aria-hidden','true');
  diagram.append(photo,svg);
  const callouts=controls.map((control,index)=>{
   const line=document.createElementNS(svgNS,'g');line.classList.add('assignment-leader');if(control.underside)line.classList.add('underside');line.dataset.anchor=String(index);
   const path=document.createElementNS(svgNS,'path');path.setAttribute('d',control.path);
   const dot=document.createElementNS(svgNS,'circle');dot.setAttribute('cx',control.anchor[0]);dot.setAttribute('cy',control.anchor[1]);dot.setAttribute('r','3');line.append(path,dot);svg.append(line);
   const button=document.createElement('button');button.type='button';button.className='assignment-callout';button.dataset.assignmentIndex=String(index);button.dataset.side=control.side;button.style.top=(control.y/560*100)+'%';
   const name=document.createElement('span');name.className='assignment-callout-name';
   const detail=document.createElement('span');detail.className='assignment-callout-detail';button.append(name,detail);
   const highlight=()=>line.classList.toggle('is-active',button.matches(':hover, :focus-visible'));
   ['mouseenter','mouseleave','focus','blur'].forEach(event=>button.addEventListener(event,highlight));
   button.addEventListener('click',()=>onSelect(index));diagram.append(button);return {button,name,detail};
  });
  const underside=document.createElement('span');underside.className='assignment-underside-note';underside.textContent='DPI · underside';diagram.append(underside);
  root.replaceChildren(heading,diagram);
  function render(mappings=[],connected=false){
   root.dataset.connected=String(connected===true);
   callouts.forEach(({button,name,detail},index)=>{
    const physical=controls[index].name,mapping=mappings[index];
    const assignment=connected&&typeof mapping?.assignment==='string'&&mapping.assignment.trim()?mapping.assignment.trim():physical;
    name.textContent=assignment;detail.textContent=assignment!==physical?physical:(controls[index].underside?'Underside':'');
    detail.hidden=!detail.textContent;button.setAttribute('aria-label',physical+': '+assignment+'. Edit assignment.');
   });
  }
  render();return {render};
 }
 return {create};
})();
