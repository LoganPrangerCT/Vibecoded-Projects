'use strict';
const $=id=>document.getElementById(id),clone=value=>value==null?value:structuredClone(value),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const state={status:{connected:false,settings:null,capabilities:{},helper:{}},macros:[],profiles:[],selected:null,steps:[],events:[],macroDirty:false,slotRead:null};
const labels={overview:'Overview',performance:'Performance',macros:'Button mapping',profiles:'Profiles',diagnostics:'Diagnostics'};
const dirtyButtons=new Set(),buttonDrafts=new Map();
let syncingPreparedMacro=false;
let toastTimer,performanceBaseline=null,performanceDirty=false,performanceOrigin=null,performanceRevision=0,performanceBusy=false,buttonRevision=0,buttonsOrigin=null,onboardProfileRevision=0,dpiDraft=null,preferenceDirty=false,preferenceRevision=0,onboardProfileDirty=false,helperStarting=false;
const optionFields={debounce:'deBounce',lod:'liftCutOff',angle:'angelSnap',sleep:'sleepTime',smooth:'smooth'},supportedOptions=['rate','deBounce','liftCutOff','angelSnap','smooth','powerSaveMode'],supportedDpi=['currentDpi','currentDPIMax','dpiArr','DPIColorArr'];
const caps=()=>state.status.capabilities||{},can=key=>state.status.connected===true&&caps()[key]===true,canRate=()=>can('options')||can('polling'),stageLimit=()=>Number(caps().dpiStages)||0,dpiMax=()=>Number(caps().dpiMax)||Number(state.status.device?.dpiMax)||42000;
const liftLevels=()=>Array.isArray(caps().liftOffLevels)?caps().liftOffLevels:caps().dpiMax===42000?[0,1,2]:[0,1];
function element(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function button(text,fn,className='secondary'){const el=element('button',text,className);el.type='button';el.addEventListener('click',fn);return el;}
function empty(root,text){root.replaceChildren(element('div',text,'empty'));}
function toast(message,error=false){$('toast').textContent=String(message);$('toast').className='visible'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').className='',5000);}
async function api(path,method='GET',data){
 if(window.r2?.request){const result=await window.r2.request(method,path,data??null);if(result?.ok===false)throw Error(result.error||result.message||'The device service could not complete this request.');return result;}
 const response=await fetch(path,{method,headers:data?{'Content-Type':'application/json'}:undefined,body:data?JSON.stringify(data):undefined});let result;try{result=await response.json();}catch{throw Error('The device service returned an unreadable response.');}if(!response.ok||result?.ok===false)throw Error(typeof result.error==='string'?result.error:result.message||'The device service could not complete this request.');return result;
}
function discard(message,title='Unsaved changes'){$('discard-title').textContent=title;$('discard-copy').textContent=message;return new Promise(resolve=>{const dialog=$('discard-dialog');let done=false;const finish=value=>{if(done)return;done=true;dialog.close();resolve(value);};$('discard-cancel').onclick=()=>finish(false);$('discard-confirm').onclick=()=>finish(true);dialog.oncancel=event=>{event.preventDefault();finish(false);};dialog.showModal();});}
async function guardMacro(){stopRecording();return !state.macroDirty||await discard('This sequence has unsaved changes. Save it on this PC before continuing, or discard the edits.','Unsaved macro');}
// REVIEW(6.1 sol): leaving Button mapping collapses an open macro editor, so the section
// always defaults back to the main assignment screen; drafts survive via the resume shelf.
function navigate(view){if(view==='buttons')view='macros';if(!labels[view])view='overview';if(view!=='macros'&&$('macros').classList.contains('macro-editing'))backToMacroAssignments();document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',el.id===view));document.querySelectorAll('nav button').forEach(el=>{const active=el.dataset.view===view;el.classList.toggle('active',active);if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});$('crumb').textContent=labels[view].toUpperCase();history.replaceState(null,'','#'+view);window.scrollTo(0,0);}
document.querySelectorAll('[data-view]').forEach(el=>el.onclick=()=>navigate(el.dataset.view));document.querySelectorAll('[data-go]').forEach(el=>el.onclick=()=>navigate(el.dataset.go));window.addEventListener('hashchange',()=>navigate(location.hash.slice(1)));navigate(location.hash.slice(1));
window.addEventListener('beforeunload',event=>{if(!window.r2&&(state.macroDirty||performanceDirty||dirtyButtons.size)){event.preventDefault();event.returnValue='';}});
function dpiPatch(value){const result={};if(value&&typeof value==='object')for(const key of supportedDpi)if(value[key]!==undefined)result[key]=clone(value[key]);return result;}
function readDpi(){const d=state.status.settings?.dpi;return Array.isArray(d?.dpiArr)?d.dpiArr[d.currentDpi||0]:undefined;}
function colorHex(value){return '#'+Number(value).toString(16).padStart(6,'0').slice(-6);}
function markPerformance(){if(!performanceDirty)performanceOrigin=macroDeviceIdentity();performanceRevision++;performanceDirty=true;$('performance-status').textContent='Unsaved changes';$('apply-performance').disabled=performanceBusy||(!can('dpi')&&!canRate());$('performance-revert').disabled=performanceBusy;syncQuickSettings();}
function syncRates(){if(performanceDirty)return;const rate=state.status.settings?.options?.rate,select=$('polling'),values=[...new Set([...(caps().pollingRates||[]),rate].filter(v=>Number(v)>0))].sort((a,b)=>a-b);select.replaceChildren(new Option('Unknown',''));values.forEach(v=>select.add(new Option(String(v),String(v))));select.value=rate?String(rate):'';}
function renderDpiStages(){
 const root=$('dpi-stages'),count=stageLimit();root.replaceChildren();$('dpi-count').replaceChildren(new Option('Unknown',''));for(let i=1;i<=count;i++)$('dpi-count').add(new Option(String(i),String(i)));$('dpi-count').value=dpiDraft?.currentDPIMax?String(dpiDraft.currentDPIMax):'';$('dpi-count').disabled=!can('dpi')||!dpiDraft;
 $('dpi-limits').textContent=count?`${count} stages · ${Number(caps().dpiMin)||50}–${dpiMax().toLocaleString()} DPI · ${Number(caps().dpiStep)||50} DPI increments`:'Connect your mouse to load its stage configuration.';
 if(!dpiDraft?.dpiArr||!count){empty(root,'DPI stages appear after a verified device read.');return;}
  // REVIEW(6.1 sol): only the enabled stages render — the count shown at any time follows
  // currentDPIMax, and the stage-count select can raise or lower it again afterward.
  for(let index=0;index<Math.min(count,dpiDraft.currentDPIMax||count);index++){
  const row=element('div',undefined,'dpi-stage'+(index===dpiDraft.currentDpi?' active-stage':''));row.dataset.stage=index;
  const radio=element('input');radio.type='radio';radio.name='active-dpi-stage';radio.id='dpi-active-'+index;radio.checked=index===dpiDraft.currentDpi;radio.disabled=!can('dpi');radio.setAttribute('aria-label','Activate DPI stage '+(index+1));radio.onchange=()=>{dpiDraft.currentDpi=index;markPerformance();renderDpiStages();};
  const label=element('label','Stage '+(index+1),'stage-name');label.htmlFor=radio.id;
  const input=element('input');input.type='number';input.min=String(caps().dpiMin||50);input.max=String(dpiMax());input.step=String(caps().dpiStep||50);input.placeholder='Uninitialized';input.value=dpiDraft.dpiArr[index]>0?String(dpiDraft.dpiArr[index]):'';input.disabled=!can('dpi');input.setAttribute('aria-label','DPI stage '+(index+1)+' sensitivity');input.oninput=()=>{const value=input.value===''?0:Number(input.value);dpiDraft.dpiArr[index]=value;dpiDraft.dpiArr[index+8]=value;markPerformance();};
  const color=element('input');color.type='color';color.value=colorHex(dpiDraft.DPIColorArr?.[index]??0);color.disabled=!can('dpi')||!Array.isArray(dpiDraft.DPIColorArr);color.setAttribute('aria-label','DPI stage '+(index+1)+' indicator color');color.oninput=()=>{dpiDraft.DPIColorArr[index]=parseInt(color.value.slice(1),16);markPerformance();};
  row.append(radio,label,input,element('span','DPI','unit'),color,element('span',radio.checked?'Active':dpiDraft.dpiArr[index]>0?'Ready':'Not set','stage-state'));root.append(row);
 }
}
$('dpi-count').onchange=()=>{if(!dpiDraft)return;const count=Number($('dpi-count').value);if(!count)return;dpiDraft.currentDPIMax=count;if(dpiDraft.currentDpi>=count)dpiDraft.currentDpi=count-1;markPerformance();renderDpiStages();};
function syncOptions(){const o=state.status.settings?.options;if(!performanceDirty){const levels=liftLevels();$('lod').replaceChildren(new Option('Unknown',''));levels.forEach((value,index)=>$('lod').add(new Option(levels.length===3?['Low','Medium','High'][index]:['Low','High'][index],String(value))));}for(const[id,key]of Object.entries(optionFields)){const value=key==='sleepTime'?o?.sleepTime?.time_24:o?.[key],el=$(id);el.disabled=!can('options')||value==null;if(!performanceDirty&&document.activeElement!==el)el.value=value==null?'':String(value);}$('debounce').max=String(caps().debounceMax??10);$('sleep').max=String(caps().sleep?.time_24?.max??3600);}
for(const id of ['polling',...Object.keys(optionFields)])$(id).addEventListener('input',markPerformance);
function validateDpi(value){if(!value||!Array.isArray(value.dpiArr)||value.dpiArr.length>16)throw Error('No valid DPI configuration is available.');const count=Number(value.currentDPIMax);if(!Number.isInteger(count)||count<1||count>(stageLimit()||8))throw Error('Choose a valid number of DPI stages.');if(!Number.isInteger(value.currentDpi)||value.currentDpi<0||value.currentDpi>=count)throw Error('Choose an enabled active DPI stage.');for(const v of value.dpiArr)if(!Number.isInteger(v)||v<0||v>dpiMax()||v%50)throw Error(`DPI must be 50–${dpiMax().toLocaleString()} in increments of 50. Zero is reserved for uninitialized stages.`);if(!(value.dpiArr[value.currentDpi]>0))throw Error('Enter a sensitivity for the active DPI stage.');if(value.DPIColorArr?.some(c=>!Number.isInteger(c)||c<0||c>0xffffff))throw Error('Invalid DPI indicator color.');return dpiPatch(value);}
function editorOptions(){const result={};if($('polling').value)result.rate=Number($('polling').value);for(const[id,key]of Object.entries(optionFields)){const el=$(id);if(el.value==='')continue;if(key==='smooth'){result.smooth=el.value==='true';continue;}const value=Number(el.value),max=id==='debounce'?Number(caps().debounceMax??10):id==='sleep'?Number(caps().sleep?.time_24?.max??3600):id==='lod'?Math.max(...liftLevels()):1;if(!Number.isInteger(value)||value<0||value>max)throw Error('Enter a valid value for '+el.labels[0].firstChild.textContent+'.');if(key==='sleepTime')result.sleepTime={time_24:value};else result[key]=value;}return result;}
async function applyPerformance(){
 if(performanceBusy||(!can('dpi')&&!canRate()))return;
 try{
  const device=macroDeviceIdentity();if(!device||device!==performanceOrigin)throw Error('The selected mouse changed after these edits. Revert or reload the draft before applying it.');
  const request={};
  if(can('dpi')&&dpiDraft&&!same(dpiDraft,dpiPatch(performanceBaseline?.dpi)))request.dpi=validateDpi(dpiDraft);
  const changes={};
  for(const[key,value]of Object.entries(editorOptions())){
   if(key==='sleepTime'){if(value.time_24!==state.status.settings?.options?.sleepTime?.time_24)changes.sleepTime=value;}
   else if(!same(value,state.status.settings?.options?.[key]))changes[key]=value;
  }
  if(Object.keys(changes).length&&can('options'))request.options=changes;
  if(!Object.keys(request).length)throw Error('There are no new supported changes to apply.');
  const revision=performanceRevision;
  performanceBusy=true;$('apply-performance').disabled=true;renderStatus();
  request.device=device;
  if(device!==macroDeviceIdentity())throw Error('The selected mouse changed. Revert or reload the draft before applying it.');
  const result=await api('/api/settings','POST',request);
  performanceBaseline=clone(result.settings||state.status.settings);
  if(performanceRevision===revision){performanceRevision++;performanceDirty=false;performanceOrigin=null;}
  await refresh();
  $('performance-status').textContent=performanceDirty?'Changes verified. Your newer edits are still unsaved.':'Changes verified on device.';
  toast(performanceDirty?'Settings saved. Newer edits remain unsaved.':'Device settings applied and verified.');
 }catch(error){toast(error.message,true);}
 finally{performanceBusy=false;renderStatus();}
}
$('apply-performance').onclick=applyPerformance;
const buttonNames=['Left button','Right button','Middle button','Forward button','Back button','DPI button'];
const mappingActions={left:[1,0,240,0],right:[1,0,241,0],middle:[1,0,242,0],back:[1,0,243,0],forward:[1,0,244,0],dpi:[20,0,0,0],disabled:[0,0,0,0]},buttonControls=[];
for(let slot=0;slot<20;slot++)$('macro-slot').add(new Option('Slot '+(slot+1),String(slot)));
for(let profile=0;profile<8;profile++)$('onboard-profile').add(new Option('Profile '+(profile+1),String(profile)));
$('onboard-profile').onchange=()=>{onboardProfileRevision++;onboardProfileDirty=true;};
for(let index=0;index<buttonNames.length;index++){
 const row=element('div',undefined,'button-row'),top=element('div',undefined,'setting-row'),label=element('label',buttonNames[index]);label.htmlFor='mouse-button-'+index;label.append(element('small','Button '+(index+1)));const select=element('select',undefined,'button-select');select.id=label.htmlFor;[['','Unknown · preserved'],['left','Left click'],['right','Right click'],['middle','Middle click'],['back','Back'],['forward','Forward'],['dpi','Cycle DPI'],['disabled','Disabled'],['macro','Onboard macro'],['combo','Keyboard combo']].forEach(([v,t])=>select.add(new Option(t,v)));
 const extras=element('div',undefined,'button-extras'),slot=element('select'),mode=element('select'),combo=element('input');slot.setAttribute('aria-label',buttonNames[index]+' macro slot');for(let n=0;n<20;n++)slot.add(new Option('Slot '+(n+1),String(n)));mode.setAttribute('aria-label',buttonNames[index]+' macro mode');[['0','Once / repeat count'],['1','Repeat until pressed again'],['2','Repeat while holding']].forEach(([v,t])=>mode.add(new Option(t,v)));combo.placeholder='e.g. Ctrl+Shift+S';combo.maxLength=80;combo.setAttribute('aria-label',buttonNames[index]+' keyboard combo');extras.append(slot,mode,combo);
 const dirty=()=>{if(syncingPreparedMacro)return;if(!dirtyButtons.size)buttonsOrigin=macroDeviceIdentity();buttonRevision++;dirtyButtons.add(index);buttonDrafts.delete(index);refreshButtonExtras(index);syncMacroAssignments();};for(const control of[select,slot,mode,combo])control.addEventListener('input',dirty);select.addEventListener('change',dirty);buttonControls.push({select,slot,mode,combo,extras});top.append(label,select);row.append(top,extras);$('button-rows').append(row);
}
function comboKeyName(code){const aliases={44:'Space',49:'\\',52:"'",53:'`',57:'CapsLock',70:'PrintScreen',71:'ScrollLock',75:'PageUp',78:'PageDown'};return aliases[code]||keyNames[code]||'Key '+code;}
function refreshButtonExtras(index){const c=buttonControls[index],macro=c.select.value==='macro',combo=c.select.value==='combo';c.extras.hidden=!macro&&!combo;c.slot.hidden=c.mode.hidden=!macro;c.combo.hidden=!combo;}
function renderMapping(index,mapping){const c=buttonControls[index];c.select.querySelectorAll('[data-custom]').forEach(o=>o.remove());const match=Object.entries(mappingActions).find(([,value])=>same(value,mapping));if(match)c.select.value=match[0];else if(mapping?.[0]===9&&mapping[2]<20&&mapping[1]<3){c.select.value='macro';c.slot.value=String(mapping[2]);c.mode.value=String(mapping[1]);}else if(Array.isArray(mapping)&&mapping[0]===0&&(mapping[2]||mapping[3])&&mapping[1]<16){c.select.value='combo';c.combo.value=[mapping[1]&1?'Ctrl':null,mapping[1]&2?'Shift':null,mapping[1]&4?'Alt':null,mapping[1]&8?'Win':null,...mapping.slice(2).filter(v=>v>0).map(v=>comboKeyName(v))].filter(Boolean).join('+');}else if(Array.isArray(mapping)){const option=new Option(mapping[0]===0?'Keyboard/custom · preserved':'Custom assignment · preserved','custom');option.dataset.custom='true';c.select.add(option);c.select.value='custom';}else c.select.value='';refreshButtonExtras(index);}
function syncButtons(){for(let index=0;index<buttonControls.length;index++){const c=buttonControls[index];if(!dirtyButtons.has(index))renderMapping(index,state.status.settings?.keyMappings?.[index]);for(const el of[c.select,c.slot,c.mode,c.combo])el.disabled=performanceBusy||!can('buttons');}$('revert-buttons').disabled=performanceBusy||!dirtyButtons.size;syncMacroAssignments();}
async function mappingFor(index){const c=buttonControls[index],value=c.select.value;if(buttonDrafts.has(index)&&!assignmentMacroPicks.has(index))return clone(buttonDrafts.get(index));if(mappingActions[value])return clone(mappingActions[value]);if(value==='macro')return[9,Number(c.mode.value),Number(c.slot.value),0];if(value==='combo'){if(!c.combo.value.trim())throw Error('Enter a keyboard combo for '+buttonNames[index]+'.');const result=await api('/api/key/compile','POST',{combo:c.combo.value.trim()});if(!Array.isArray(result.mapping)||result.mapping.length!==4)throw Error('The key compiler returned an invalid mapping.');return result.mapping;}return null;}
async function changedButtonMappings(){const revision=buttonRevision,result=[];for(const index of [...dirtyButtons]){const mapping=await mappingFor(index);if(revision!==buttonRevision)throw Error('Button assignments changed while preparing this save. Apply again.');if(mapping&&!same(mapping,state.status.settings?.keyMappings?.[index]))result.push({index,mapping});}return result;}
function slotSummary(slot){
 const device=macroDeviceIdentity(),key=device+'|'+slot.index,display=macroSlotDisplayNames.get(key),events=slot.decoded?.macro;
 const observed=slot.empty!==undefined||slot.erased!==undefined||slot.raw!==undefined||slot.decoded!==undefined||slot.decodeError!==undefined;
 const emptySlot=slot.empty===true||slot.erased===true||Array.isArray(slot.raw)&&slot.raw.length===256&&slot.raw.every(byte=>byte===0);
 if(emptySlot){macroSlotDisplayNames.delete(key);return 'Empty';}
 const identity=Array.isArray(events)?macroContentIdentity(slot.decoded):null;
 if(display&&(!observed||identity===display.contentIdentity))return display.name;
 if(observed)macroSlotDisplayNames.delete(key);
 if(Array.isArray(events)){
  const owned=state.macros.filter(m=>{const record=macroUploadRecord(m);return record?.device===device&&record.slot===slot.index&&record.contentIdentity===identity;});
  if(owned.length===1)return owned[0].name;
  const exact=state.macros.filter(m=>macroContentIdentity(m)===identity);if(exact.length===1)return exact[0].name;
  const labels=events.map(e=>e.type==='delay'?'Delay '+e.value+' ms':e.type==='mouse_button'?(e.value||'Mouse')+' '+(e.action==='up'?'release':'press'):e.type==='keyboard'?(typeof keyNames!=='undefined'?keyNames[e.value]||'Key '+e.value:'Key '+e.value)+' '+(e.action==='up'?'release':'press'):e.type==='mouse_move'?'Move '+e.dx+','+e.dy:'Event');
  return (labels.slice(0,2).join(' · ')+(labels.length>2?' · +'+(labels.length-2)+' more':''))+' · '+events.length+' events';
 }
 if(!observed)return macroForSlot(slot.index)?.name||'Not read';
 return slot.decodeError?'Unreadable stored macro':'Stored macro';
}
function refreshVisibleSlotLabels(){
 const slots=macroSlotInventoryDevice===macroDeviceIdentity()&&macroSlotInventory.length?macroSlotInventory:Array.from({length:20},(_,index)=>({index}));
 for(const select of[$('macro-slot'),...buttonControls.map(c=>c.slot)]){
  const selected=select.value;select.replaceChildren(...slots.map(slot=>new Option('Slot '+(slot.index+1)+' · '+slotSummary(slot)+(slot.reserved?' · used by button assignments':''),String(slot.index))));
  if(slots.some(s=>String(s.index)===selected))select.value=selected;
 }
}
async function refreshMacroSlots(){const device=macroDeviceIdentity();if(!device)return;const result=await api('/api/macros/slots');if(device!==macroDeviceIdentity()||result.device!==device)throw Error('The selected mouse changed while reading its macro slots.');macroSlotInventory=Array.isArray(result.slots)?result.slots:[];macroSlotInventoryDevice=device;refreshVisibleSlotLabels();return result;}
async function chooseReplacementSlot(slots,macro,device,revision){const dialog=$('macro-slot-picker'),list=$('macro-slot-choices'),copy=$('macro-slot-picker-copy'),use=$('macro-slot-picker-use');copy.textContent='All macro slots are occupied. Choose one to replace for '+macro.name+'. Buttons bound to that slot will use the new macro.';list.replaceChildren();use.disabled=true;return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;dialog.close();resolve(value);};for(const slot of slots){const row=element('label',undefined,'slot-choice'),radio=element('input');radio.type='radio';radio.name='replacement-slot';radio.value=String(slot.index);radio.disabled=slot.replaceable!==true||slot.protected===true;radio.addEventListener('change',()=>{use.disabled=false;});const detail=element('span','Slot '+(slot.index+1)+' · '+slotSummary(slot)+(slot.protected?' · protected':slot.reserved?' · used by button assignments':''));row.append(radio,detail);list.append(row);} $('macro-slot-picker-cancel').onclick=()=>finish(null);$('macro-slot-picker-use').onclick=()=>{const chosen=slots.find(s=>Array.from(list.children).some(row=>row.children[0].checked&&String(s.index)===row.children[0].value));if(!chosen||!chosen.replaceable||chosen.protected)return;finish(chosen);};dialog.oncancel=e=>{e.preventDefault();finish(null);};dialog.showModal();});}
async function prepareNamedMacro(macro,device,revision,ids,reservedForApply=[]){const preferred=macroOnboardSlot(macro),reservedSlots=[...new Set([...reservedForApply,...[...dirtyButtons].filter(i=>buttonControls[i].select.value==='macro'&&!ids.includes(assignmentMacroPicks.get(i))).map(i=>Number(buttonControls[i].slot.value))])];let result=await api('/api/macros/prepare','POST',{macro,device,...(preferred===null?{}:{preferredSlot:preferred}),reservedSlots});if(device!==macroDeviceIdentity()||result.device!==device)throw Error('The selected mouse changed. Apply assignments again.');if(buttonRevision!==revision)throw Error('Button assignments changed while preparing this save. Apply again.');if(result.needsSlot!==true){if(result.verified!==true||!Number.isInteger(result.slot)||result.slot<0||result.slot>=20||!Array.isArray(result.canonical?.macro))throw Error('The device did not verify the prepared macro.');return result;}if(!Array.isArray(result.slots))throw Error('The service returned an invalid macro slot list.');macroSlotInventory=result.slots;macroSlotInventoryDevice=device;refreshVisibleSlotLabels();const chosen=await chooseReplacementSlot(result.slots,macro,device,revision);if(!chosen)return null;if(device!==macroDeviceIdentity()||buttonRevision!==revision)throw Error('The assignment or selected mouse changed. Apply again.');result=await api('/api/macros/prepare','POST',{macro,device,reservedSlots,replaceSlot:chosen.index,replaceFingerprint:chosen.fingerprint});if(device!==macroDeviceIdentity()||result.device!==device||buttonRevision!==revision)throw Error('Assignments or mouse changed while preparing this save. Apply again.');if(result.needsSlot===true||result.verified!==true||!Number.isInteger(result.slot)||result.slot<0||result.slot>=20||!Array.isArray(result.canonical?.macro))throw Error('The device did not verify the prepared macro.');return result;}
$('apply-buttons').onclick=async()=>{if(performanceBusy||!can('buttons'))return;performanceBusy=true;renderStatus();try{const revision=buttonRevision,device=macroDeviceIdentity(),ids=[...new Set([...dirtyButtons].map(i=>typeof assignmentMacroPicks==='undefined'?null:assignmentMacroPicks.get(i)).filter(Boolean))],preparedRecords=[],reservedForApply=[];if(!device||device!==buttonsOrigin)throw Error('The selected mouse changed after these edits. Revert or reload the draft before applying it.');if(ids.length)refreshVisibleSlotLabels();if(device!==macroDeviceIdentity()||buttonRevision!==revision)throw Error('Assignments or mouse changed while preparing this save. Apply again.');for(const id of ids){const macro=state.macros.find(m=>m.id===id);if(!macro)throw Error('The selected saved macro is no longer available.');const prepared=await prepareNamedMacro(macro,device,revision,ids,reservedForApply);if(prepared===null)return;if(prepared.verified!==true||!Number.isInteger(prepared.slot)||!Array.isArray(prepared.canonical?.macro))throw Error('The device did not verify the prepared macro.');if(device!==macroDeviceIdentity())throw Error('The selected mouse changed. Apply assignments again.');if(buttonRevision!==revision)throw Error('Button assignments changed while preparing this save. Apply again.');await rememberMacroSlot(macro,prepared.slot,prepared.canonical,device,macroRevision,[]);if(device!==macroDeviceIdentity()||buttonRevision!==revision)throw Error('Assignments or mouse changed while saving macro metadata. Apply again.');preparedRecords.push({slot:prepared.slot,macro:prepared.canonical});reservedForApply.push(prepared.slot);for(const index of dirtyButtons)if(assignmentMacroPicks.get(index)===id){buttonControls[index].slot.value=String(prepared.slot);buttonDrafts.delete(index);}}if(ids.length)refreshVisibleSlotLabels();const buttonMappings=await changedButtonMappings();if(buttonRevision!==revision)throw Error('Button assignments changed while preparing this save. Apply again.');if(!buttonMappings.length&&!preparedRecords.length)throw Error('Choose a different button assignment first.');if(ids.length&&device!==macroDeviceIdentity())throw Error('The selected mouse changed. Apply assignments again.');if(device!==macroDeviceIdentity())throw Error('The selected mouse changed. Revert or reload the draft before applying it.');await api(ids.length?'/api/macros/bind':'/api/settings','POST',ids.length?{device,buttonMappings,prepared:preparedRecords}:{device,buttonMappings});if(buttonRevision===revision){buttonRevision++;dirtyButtons.clear();buttonDrafts.clear();resetMacroAssignmentDraftState();buttonsOrigin=null;}await refresh();toast('Button assignments applied and verified.');}catch(error){toast(error.message,true);}finally{performanceBusy=false;renderStatus();}};
$('revert-buttons').onclick=()=>{buttonRevision++;dirtyButtons.clear();buttonDrafts.clear();buttonsOrigin=null;resetMacroAssignmentDraftState();syncButtons();$('revert-buttons').disabled=true;};
for(const type of ['input','change'])$('button-rows').addEventListener(type,()=>{$('revert-buttons').disabled=!dirtyButtons.size;});
async function refresh(){try{receiveStatus(await api('/api/status'));}catch(error){toast(error.message,true);}}
function receiveStatus(value){if(value?.status&&value.connected===undefined)value=value.status;if(!value||typeof value!=='object')return;state.status=value;renderStatus();}
function activityTime(value){if(value==null)return '';const parsed=typeof value==='string'&&/^\d{11,}$/.test(value)?Number(value):value;const date=new Date(parsed);return Number.isNaN(date.getTime())?String(value):date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function detailList(id,rows){const root=$(id);root.replaceChildren();for(const[key,value]of rows)root.append(element('dt',key),element('dd',String(value??'Unknown')));}
function renderStatus(){
 const s=state.status,connected=s.connected===true,helper=s.helper||{},model=caps().model||s.device?.model||'R2';$('connection').textContent=connected?model+' connected':'Disconnected';$('connection').classList.toggle('online',connected);$('side-status').textContent=connected?(s.device?.connection||'Connected'):'Not connected';$('hero-status').textContent=connected?model+' connected':'Waiting for your mouse';$('connect-title').textContent=connected?'Connected':helper.running?'Looking for your mouse…':'Let’s get connected.';$('connect-copy').textContent=connected?(caps().variant||s.device?.variant||model)+' · '+(s.device?.connection||'Connected'):helper.running?'Connect your mouse or receiver. Settings appear after a verified read.':'Connect your mouse or receiver, then start the local device helper.';$('start-helper').disabled=!!helper.running;$('start-helper').textContent=helper.running?'Device helper running':'Start device helper ↗';$('helper-note').textContent=helper.error||'';
 const battery=connected&&s.device?.online!==false&&Number.isFinite(s.device?.battery)&&s.device.battery>=0&&s.device.battery<=100?s.device.battery:null;
 document.querySelector('.helper-fact').hidden=connected&&helper.running===true&&!helper.error;
 $('start-helper').disabled=helperStarting;$('start-helper').textContent=helperStarting?'Connecting…':helper.running?'Reconnect':'Start helper';
 $('battery-level').textContent=battery===null?'Unavailable':battery+'%';$('battery-meter').hidden=battery===null;$('battery-meter').value=battery??0;$('battery-meter').classList.toggle('low',battery!==null&&battery<=20);if(battery!==null)$('side-status').textContent+=' · '+battery+'%';
 const dpi=readDpi(),rate=s.settings?.options?.rate;$('metric-dpi').replaceChildren(document.createTextNode(dpi>0?dpi+' ':'— '),element('small','DPI'));$('metric-polling').replaceChildren(document.createTextNode(rate?rate+' ':'— '),element('small','Hz'));
 if(!performanceDirty){performanceBaseline=clone(s.settings);dpiDraft=s.settings?.dpi?dpiPatch(s.settings.dpi):null;renderDpiStages();}else document.querySelectorAll('#dpi-stages input').forEach(el=>el.disabled=!can('dpi')||Number(el.closest('.dpi-stage').dataset.stage)>=(dpiDraft?.currentDPIMax||0));
 syncRates();syncOptions();syncButtons();$('dpi-count').disabled=!can('dpi')||!dpiDraft;$('polling').disabled=!canRate();$('apply-performance').disabled=performanceBusy||!performanceDirty||performanceOrigin!==macroDeviceIdentity()||(!can('dpi')&&!canRate());$('apply-buttons').disabled=performanceBusy||!can('buttons')||!dirtyButtons.size||buttonsOrigin!==macroDeviceIdentity()||(typeof hasBlockedMacroAssignment==='function'&&hasBlockedMacroAssignment());$('switch-profile').disabled=performanceBusy||!connected||!s.settings||caps().profiles===false;$('onboard-profile').disabled=$('switch-profile').disabled;if(!onboardProfileDirty&&document.activeElement!==$('onboard-profile'))$('onboard-profile').value=String(s.settings?.profile??s.settings?.dpi?.profile??0);$('onboard-profile-status').textContent=s.settings?'Active onboard profile: '+(Number(s.settings.profile??s.settings.dpi?.profile??0)+1):'Current profile is unknown.';document.querySelectorAll('[data-device-write]').forEach(el=>el.disabled=performanceBusy||!connected);
 document.querySelectorAll('.hardware-notice').forEach(el=>el.textContent=connected?'':'Connect your mouse to apply changes.');$('upload-macro').disabled=!can('macros')||macroUploadBusy;$('upload-macro').textContent=can('macros')?'Sync selected macro to mouse':'Sync selected macro · Unavailable';$('read-macro-slot').disabled=!connected||!s.settings;$('macro-upload-note').textContent=can('macros')?'Save on PC keeps a local copy. Sync to inspect or manage its onboard copy.':'Save on PC keeps a local copy. Connect your mouse to sync.';
 detailList('helper-details',[['Status',helper.running?'Running':'Stopped'],['Version',helper.version],['Device',caps().variant||s.device?.variant||s.device?.model],['Connection',s.device?.connection],['Battery',battery===null?'Unknown':battery+'%'],['Last error',helper.error||'None reported']]);detailList('capability-details',Object.entries(caps()).map(([key,value])=>[key,typeof value==='boolean'?(value?'Verified':'Unavailable'):typeof value==='object'?JSON.stringify(value):value]));$('raw-status').textContent=JSON.stringify(s,null,2);const activity=$('activity-list');activity.replaceChildren();if(!s.activity?.length)activity.append(element('li','No activity reported yet.'));else[...s.activity].slice(0,30).forEach(item=>activity.append(element('li',typeof item==='string'?item:[activityTime(item.time??item.timestamp),item.message||item.event||JSON.stringify(item)].filter(Boolean).join(' · '))));
 $('performance-revert').disabled=performanceBusy||!performanceDirty;
 syncQuickSettings();
}
$('refresh').onclick=refresh;$('diagnostic-refresh').onclick=refresh;
$('start-helper').onclick=async()=>{if(helperStarting)return;helperStarting=true;renderStatus();try{await api('/api/helper/start','POST',{});await refresh();toast('Checking your mouse connection.');}catch(error){toast(error.message,true);}finally{helperStarting=false;renderStatus();}};
$('switch-profile').onclick=async()=>{if(performanceBusy)return;const device=macroDeviceIdentity();if(!device)return;performanceBusy=true;renderStatus();try{if((performanceDirty||dirtyButtons.size)&&!await discard('Switching onboard profiles replaces the DPI, performance, and button drafts in this editor. Save a local profile first to keep them.'))return;if(device!==macroDeviceIdentity())throw Error('The selected mouse changed. Choose the profile again.');const profile=Number($('onboard-profile').value),revision=performanceRevision,buttons=buttonRevision,onboard=onboardProfileRevision;await api('/api/profile','POST',{profile,device});if(onboard===onboardProfileRevision){onboardProfileRevision++;onboardProfileDirty=false;}if(revision===performanceRevision){performanceRevision++;performanceDirty=false;performanceOrigin=null;}if(buttons===buttonRevision){buttonRevision++;dirtyButtons.clear();buttonDrafts.clear();buttonsOrigin=null;resetMacroAssignmentDraftState();}await refresh();performanceBaseline=clone(state.status.settings);toast('Switched to onboard profile '+(profile+1)+'.');}catch(error){toast(error.message,true);}finally{performanceBusy=false;renderStatus();}};

const mouseButtons=['left','right','middle','back','forward'];
const keyNames={40:'Enter',41:'Escape',42:'Backspace',43:'Tab',44:'Space',45:'-',46:'=',47:'[',48:']',49:'Backslash',51:';',52:'Quote',53:'Backtick',54:',',55:'.',56:'/',57:'Caps Lock',70:'Print Screen',71:'Scroll Lock',72:'Pause',73:'Insert',74:'Home',75:'Page Up',76:'Delete',77:'End',78:'Page Down',79:'Right',80:'Left',81:'Down',82:'Up',83:'Num Lock',224:'Left Ctrl',225:'Left Shift',226:'Left Alt',227:'Left Win',228:'Right Ctrl',229:'Right Shift',230:'Right Alt',231:'Right Win'};
for(let i=0;i<26;i++)keyNames[4+i]=String.fromCharCode(65+i);for(let i=0;i<10;i++)keyNames[30+i]=String((i+1)%10);for(let i=0;i<12;i++)keyNames[58+i]='F'+(i+1);for(let i=0;i<12;i++)keyNames[104+i]='F'+(i+13);
Object.assign(keyNames,{84:'Numpad /',85:'Numpad *',86:'Numpad −',87:'Numpad +',88:'Numpad Enter',98:'Numpad 0',99:'Numpad .',100:'Intl Backslash',101:'Context Menu',103:'Numpad ='});for(let i=1;i<=9;i++)keyNames[88+i]='Numpad '+i;
let macroRevision=0,macroEditor=0,macroSave=null,selectedEvent=-1;
$('macro-playback').onchange=()=>{syncMacroPlayback();macroChanged();};
function macroChanged(){macroRevision++;state.macroDirty=true;}
function setStepTypes(){stopRecording();recordArea.hidden=true;recordButton.disabled=false;}
let recording=false;
const recorder=element('div',undefined,'recorder'),recordArea=element('div',undefined,'recording-area');
const recordStatus=element('span','Keyboard + mouse','fine');
const recordButton=button('Record inputs',async()=>{

 if(recording){stopRecording();return;}
 recordButton.disabled=true;
 try{
  const editor=macroEditor,revision=macroRevision;
  let events=state.events;
  if(!events&&state.steps.length){
   const compiled=await api('/api/macros/preview','POST',{macro:{repeatCount:Number($('macro-repeat').value)||1,steps:clone(state.steps)}});
   events=compiled.canonical.macro;
  }
  if(editor!==macroEditor||revision!==macroRevision)throw Error('The sequence changed while preparing to record. Start recording again.');
  state.events=clone(events||[]);state.steps=[];setStepTypes();renderSteps();
  recordArea.hidden=false;
  inputCapture.start({events:state.events});
  recordArea.scrollIntoView({block:'nearest'});
 }catch(error){toast(error.message,true);}finally{recordButton.disabled=false;}
});
recordButton.id='record-macro';recordArea.id='macro-recording-area';recordArea.tabIndex=0;
recordArea.setAttribute('role','application');recordArea.setAttribute('aria-label','Mouse and keyboard recording area');recordArea.hidden=true;
recorder.append(recordButton,recordStatus,recordArea);$('macro-steps').before(recorder);
const inputCapture=window.R2Recorder.create({
 zone:recordArea,
 onEvent(event){state.events.push(event);macroChanged();renderSteps();$('macro-steps').scrollLeft=$('macro-steps').scrollWidth;},
 onState(update){
  recording=update.recording;recordButton.textContent=recording?'Stop recording':'Record inputs';
  recordArea.hidden=!recording;
  recorder.classList.toggle('is-recording',recording);recordArea.dataset.recording=String(recording);
  recordStatus.textContent=recording?'Recording · '+update.count+' events · '+update.usedBytes+'/256 bytes':'';
  recordArea.textContent=recording?'Click here with any mouse button, or press keys. Escape stops recording.':'';
  if(update.reason==='limit')toast('Recording reached the onboard byte limit. Held inputs were released.',true);
  if(recording&&update.reason==='window-blur')recordStatus.textContent+=' · App lost focus';
 },
 canAcceptEvents(events){try{validateMacro({name:'Recording',repeatCount:1,macro:events});return true;}catch{return events.length===0;}}
});
function stopRecording(){inputCapture.stop();}
// Editing controls finish recording; clicks inside the capture area keep it active.
recorder.closest('.editor').addEventListener('mousedown',event=>{if(recording&&!recorder.contains(event.target))stopRecording();},true);
const manualPanel=element('details',undefined,'manual-event-add'),manualSummary=element('summary','＋ Add event');
manualPanel.append(manualSummary);
const manualFields=element('div',undefined,'manual-event-fields');
function manualField(labelText,control){const label=element('label');label.append(element('span',labelText),control);manualFields.append(label);return label;}
const manualType=element('select');manualType.id='manual-event-type';
[['key','Keyboard'],['click','Mouse click'],['delay','Delay'],['mouse_move','Movement']].forEach(([value,text])=>manualType.add(new Option(text,value)));
manualField('Type',manualType);
const manualValue=element('input');manualValue.id='manual-event-value';manualValue.maxLength=80;
const manualValueLabel=manualField('Key or combo',manualValue),manualMouse=element('select');manualMouse.id='manual-event-mouse';
mouseButtons.forEach(value=>manualMouse.add(new Option(value[0].toUpperCase()+value.slice(1),value)));
const manualMouseLabel=manualField('Mouse button',manualMouse),manualY=element('input');manualY.id='manual-event-y';manualY.type='number';manualY.min='-128';manualY.max='127';manualY.value='0';
const manualYLabel=manualField('Y',manualY),manualAdd=button('Add',async()=>{
 stopRecording();manualAdd.disabled=true;
 try{await manualEvents.append({type:manualType.value,value:manualType.value==='click'?manualMouse.value:manualValue.value,dy:manualY.value});}
 catch(error){toast(error.message,true);}finally{manualAdd.disabled=false;}
});manualAdd.id='add-manual-event';manualFields.append(manualAdd);manualPanel.append(manualFields);recorder.after(manualPanel);
function syncManualFields(){const type=manualType.value;manualMouseLabel.hidden=type!=='click';manualValueLabel.hidden=type==='click';manualYLabel.hidden=type!=='mouse_move';manualValueLabel.firstChild.textContent=type==='key'?'Key or combo':type==='delay'?'Delay (ms)':'X';manualValue.type=type==='key'?'text':'number';manualValue.value=type==='key'?'':type==='delay'?'50':'0';manualValue.placeholder=type==='key'?'Ctrl+Shift+S':'';manualValue.min=type==='delay'?'1':'-128';manualValue.max=type==='delay'?'65535':'127';}
manualType.onchange=syncManualFields;syncManualFields();
const manualEvents=window.R2ManualEvents.create({
 read:()=>({editor:macroEditor,revision:macroRevision,events:state.events,steps:state.steps}),
 compile:macro=>api('/api/macros/preview','POST',{macro}),
 commit:events=>{state.events=events;state.steps=[];macroChanged();renderSteps();$('macro-steps').scrollLeft=$('macro-steps').scrollWidth;}
});
$('macro-name').oninput=macroChanged;$('macro-repeat').oninput=macroChanged;
function resetMacro(){stopRecording();macroEditor++;selectedEvent=-1;recordArea.hidden=true;state.selected=null;state.events=[];state.steps=[];state.slotRead=null;state.macroDirty=false;$('macro-name').value='';$('macro-playback').value='once';syncMacroPlayback();renderMacros();renderSteps();setStepTypes();}
$('new-macro').onclick=async()=>{if(await guardMacro()){resetMacro();openMacroEditor();$('macro-name').focus();}};
function renderMacros(){$('delete-macro').disabled=!state.selected||(typeof macroSave!=='undefined'&&!!macroSave)||(typeof macroDeleteBusy!=='undefined'&&macroDeleteBusy);const root=$('macro-list'),query=($('macro-search')?.value||'').trim().toLocaleLowerCase(),macros=state.macros.filter(macro=>macro.name.toLocaleLowerCase().includes(query));root.replaceChildren();if(!macros.length){if(query)empty(root,'No matching macros.');return;}for(const macro of macros){const el=button('',()=>selectMacro(macro.id),'library-item'+(state.selected===macro.id?' selected':''));el.append(element('span',macro.name),element('small',(macro.macro?.length??macro.steps?.length??0)+(macro.macro?' events':' steps')));root.append(el);}}
async function selectMacro(id,skipGuard=false){const macro=state.macros.find(m=>m.id===id);if(!macro)return;stopRecording();if(state.selected===id){openMacroEditor();return;}if(!skipGuard&&!await guardMacro())return;macroEditor++;state.selected=id;state.steps=clone(macro.steps||[]);state.events=Array.isArray(macro.macro)?clone(macro.macro):null;state.slotRead=null;state.macroDirty=false;$('macro-name').value=macro.name;const playback=['once','count','again','hold'].includes(macro.playbackMode)?macro.playbackMode:Number(macro.repeatCount)>1?'count':'once';$('macro-playback').value=playback;$('macro-repeat').value=String(playback==='count'?macro.repeatCount??1:1);syncMacroPlayback();renderMacros();renderSteps();setStepTypes();openMacroEditor();}
function syncMacroPlayback(){const playback=$('macro-playback').value;if(playback!=='count')$('macro-repeat').value='1';$('macro-count-field').hidden=playback!=='count';}
function valueInput(value,label,oninput,type='text'){const input=element('input',undefined,'step-value');input.type=type;input.value=String(value??'');input.setAttribute('aria-label',label);input.addEventListener('input',()=>{oninput(type==='number'?Number(input.value):input.value);macroChanged();});input.addEventListener('change',renderSteps);return input;}
const macroInspector=element('div',undefined,'macro-inspector');
macroInspector.id='macro-inspector';$('macro-steps').after(macroInspector);
let timelineEditor=-1;
function eventTitle(step){
 if(step.type==='keyboard')return keyNames[step.value]||'Key '+step.value;
 if(['mouse_button','click'].includes(step.type))return {left:'Left',right:'Right',middle:'Middle',back:'Back',forward:'Forward'}[step.value]||step.value;
 if(step.type==='mouse_move')return step.dx+', '+step.dy;
 return String(step.value??'');
}
function selectEvent(index,focus=false){selectedEvent=index;renderSteps();const tile=$('macro-steps').querySelector('[data-event="'+index+'"]');tile?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});if(focus)(tile?.querySelector('.event-keycap')||tile?.querySelector('.event-delay-select'))?.focus();}
function renderSteps(){
 if(timelineEditor!==macroEditor){selectedEvent=-1;timelineEditor=macroEditor;}
 const root=$('macro-steps'),steps=state.events||state.steps,scrollLeft=root.scrollLeft;
 selectedEvent=Math.min(selectedEvent,steps.length-1);
 root.replaceChildren();macroInspector.replaceChildren();macroInspector.hidden=selectedEvent<0;
 if(!steps.length){empty(root,'Add an event or start recording.');return;}
 const track=element('div',undefined,'macro-track');track.setAttribute('role','list');track.setAttribute('aria-label','Macro sequence');root.append(track);
 steps.forEach((step,index)=>{
  const delay=step.type==='delay',row=element('div',undefined,'step-row timeline-event'+(delay?' timeline-delay':'')+(index===selectedEvent?' selected':''));row.dataset.event=String(index);row.setAttribute('role','listitem');
  const action=step.action==='up'?'Release':'Press',title=eventTitle(step),raw=['keyboard','mouse_button'].includes(step.type);
  row.append(element('span',String(index+1).padStart(2,'0'),'step-number'));
  if(delay){
   const field=element('label',undefined,'timeline-delay-field');field.append(valueInput(step.value,'Step '+(index+1)+' value in milliseconds',v=>step.value=v,'number'),element('span','ms'));const input=field.firstChild;input.min='0';input.max='65535';input.step='1';
   const edit=button('Delay',()=>selectEvent(index),'event-delay-select');edit.setAttribute('aria-label','Edit delay '+(index+1));edit.setAttribute('aria-pressed',String(index===selectedEvent));row.append(field,edit);
  }else{
   const keycap=button('',()=>selectEvent(index),'event-keycap');keycap.setAttribute('aria-pressed',String(index===selectedEvent));keycap.setAttribute('aria-label','Event '+(index+1)+': '+(raw?action+' ':'')+title+(step.type==='key'||step.type==='click'?' tap':''));
   keycap.append(element('span',step.type==='mouse_move'?'↔':raw?(step.action==='up'?'↑':'↓'):'↕','event-direction'),element('span',title,'event-key-label'));
   keycap.onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();selectEvent(Math.max(0,Math.min(steps.length-1,index+(event.key==='ArrowLeft'?-1:1))),true);};
   row.append(keycap,element('span',raw?action:step.type==='mouse_move'?'Move':'Tap','event-caption'));
  }
  track.append(row);
 });
 root.scrollLeft=scrollLeft;
 if(selectedEvent<0)return;
 const index=selectedEvent,step=steps[index],group=element('div',undefined,'step-fields');
 macroInspector.append(element('span','Event '+String(index+1).padStart(2,'0'),'inspector-label'));
 const changed=()=>{macroChanged();renderSteps();};
 if(state.events&&step.type==='keyboard'){
  const select=element('select');select.setAttribute('aria-label','Event '+(index+1)+' key');const keys={...keyNames};if(!keys[step.value])keys[step.value]='Key '+step.value;Object.entries(keys).forEach(([v,t])=>select.add(new Option(t,v)));select.value=String(step.value);select.onchange=()=>{step.value=Number(select.value);changed();};group.append(select);
 }else if(state.events&&step.type==='mouse_button'){
  const select=element('select');select.setAttribute('aria-label','Event '+(index+1)+' mouse button');mouseButtons.forEach(v=>select.add(new Option(v[0].toUpperCase()+v.slice(1),v)));select.value=step.value;select.onchange=()=>{step.value=select.value;changed();};group.append(select);
 }else if(step.type==='mouse_move')group.append(valueInput(step.dx,'Event '+(index+1)+' X movement',v=>step.dx=v,'number'),valueInput(step.dy,'Event '+(index+1)+' Y movement',v=>step.dy=v,'number'));
 else if(step.type!=='delay')group.append(valueInput(step.value,'Step '+(index+1)+' value',v=>step.value=v));
 if(['keyboard','mouse_button'].includes(step.type)){
  const select=element('select');select.setAttribute('aria-label','Event '+(index+1)+' action');select.add(new Option('↓ Press','down'));select.add(new Option('↑ Release','up'));select.value=step.action;select.onchange=()=>{step.action=select.value;changed();};group.append(select);
 }
 macroInspector.append(group);
 const actions=element('div',undefined,'event-tools');
 for(const [symbol,offset]of[['←',-1],['→',1]]){
  const move=button(symbol,()=>{[steps[index+offset],steps[index]]=[steps[index],steps[index+offset]];selectedEvent=index+offset;changed();},'event-tool');move.disabled=index+offset<0||index+offset>=steps.length;move.setAttribute('aria-label','Move step '+(index+1)+(offset<0?' earlier':' later'));actions.append(move);
 }
 const remove=button('Delete',()=>{steps.splice(index,1);selectedEvent=Math.min(index,steps.length-1);changed();},'event-tool danger');remove.setAttribute('aria-label','Delete step '+(index+1));actions.append(remove);macroInspector.append(actions);
}
function bounded(value,min,max,name){if(!Number.isInteger(value)||value<min||value>max)throw Error(name+' must be '+min+'–'+max+'.');return value;}
function validateMacro(macro){
 if(!macro||typeof macro.name!=='string'||!macro.name.trim()||macro.name.length>80)throw Error('Give your macro a name of 1–80 characters.');bounded(Number(macro.repeatCount??1),1,65535,'Repeat count');
 const raw=Array.isArray(macro.macro),steps=raw?macro.macro:macro.steps;if(!Array.isArray(steps)||!steps.length||steps.length>(raw?126:100))throw Error('A sequence needs 1–'+(raw?126:100)+(raw?' events.':' steps.'));
 for(const step of steps){if(!step||typeof step!=='object')throw Error('Invalid macro event.');if(step.type==='delay'){bounded(Number(step.value),0,65535,'Delay');step.value=Number(step.value);}else if(raw&&step.type==='keyboard'){bounded(step.value,4,239,'Keyboard key');if(!['down','up'].includes(step.action))throw Error('Choose a keyboard event action.');}else if(raw&&step.type==='mouse_move'){bounded(step.dx,-128,127,'X movement');bounded(step.dy,-128,127,'Y movement');}else if((!raw&&step.type==='click')||(raw&&step.type==='mouse_button')){if(!mouseButtons.includes(step.value))throw Error('Choose left, right, middle, back, or forward.');if(raw&&!['down','up'].includes(step.action))throw Error('Choose a mouse event action.');}else if(!raw&&step.type==='key'){if(typeof step.value!=='string'||!step.value.trim()||step.value.length>80)throw Error('Enter a key or combo of 1–80 characters.');}else throw Error('Unsupported macro event type.');}
 return macro;
}
function draftMacro(){stopRecording();const playback=$('macro-playback').value;if(playback==='count'&&$('macro-repeat').value==='')throw Error('Enter a repeat count.');if(state.draftMacroEditor!==macroEditor){state.draftMacroEditor=macroEditor;state.draftMacroId=crypto.randomUUID();}const id=state.selected||state.draftMacroId;const macro={id,name:$('macro-name').value.trim(),playbackMode:playback,repeatCount:playback==='count'?Number($('macro-repeat').value):1,updatedAt:new Date().toISOString()};
 if(state.events)macro.macro=clone(state.events);else macro.steps=clone(state.steps);return validateMacro(macro);}




let macroMutation=Promise.resolve();
// Resolve collection mutations in order, against the last successful library. A late
// upload can update metadata, but cannot restore a deleted macro or erase an import.
function persistMacros(update){const operation=macroMutation.then(async()=>{const next=update(state.macros);await api('/api/macros','PUT',{macros:next});state.macros=next;renderMacros();syncMacroAssignments();});macroMutation=operation.catch(()=>{});return operation;}
async function saveMacro(){
 if(macroSave)return macroSave;
 const macro=draftMacro(),revision=macroRevision,editor=macroEditor;
 $('save-macro').disabled=true;$('delete-macro').disabled=true;
 macroSave=(async()=>{
  await persistMacros(current=>{const previous=current.find(m=>m.id===macro.id),upload=macroUploadSlots.get(macro.id)||previous?.onboardUpload;return [...current.filter(m=>m.id!==macro.id),{...macro,...(upload?{onboardUpload:upload}:{})}];});
  // Saving a snapshot must not clear edits typed while Rust was writing it,
  // or replace a different sequence opened while that save was in flight.
  if(editor===macroEditor){state.selected=macro.id;state.macroDirty=revision!==macroRevision;}
  renderMacros();
  toast(editor===macroEditor&&state.macroDirty?'Snapshot saved. Your newer edits are still unsaved.':'Macro saved on this PC.');
  return true;
 })();
 try{return await macroSave;}finally{macroSave=null;$('save-macro').disabled=false;renderMacros();}
}
$('save-macro').onclick=async()=>{try{await saveMacro();}catch(error){toast(error.message,true);}};
$('delete-macro').onclick=async()=>{
 if(macroSave||macroDeleteBusy||!state.selected)return;
 const id=state.selected,editor=macroEditor,revision=macroRevision;
 macroDeleteBusy=true;$('delete-macro').disabled=true;
 try{
  if(!await guardMacro()||state.selected!==id||editor!==macroEditor||revision!==macroRevision)return;
  await persistMacros(current=>current.filter(m=>m.id!==id));macroUploadSlots.delete(id);
  clearDeletedMacroAssignments(id);
  if(state.selected===id&&editor===macroEditor&&revision===macroRevision){resetMacro();backToMacroAssignments();}
  else if(state.selected===id){state.selected=null;state.macroDirty=true;}
  toast('Local macro removed. Onboard slots are unchanged.');
 }catch(error){toast(error.message,true);}
 finally{macroDeleteBusy=false;renderMacros();syncMacroAssignments();}
};
function downloadJson(value,name){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=element('a');a.href=url;a.download=name.replace(/[^a-z0-9_-]/gi,'_')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('export-macro').onclick=()=>{try{const macro=draftMacro();downloadJson({format:'r2-macros',version:2,macros:[macro]},macro.name);toast('Macro exported.');}catch(error){toast(error.message,true);}};
$('import-macro').onclick=()=>$('macro-file').click();
$('macro-file').onchange=async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>1000000)throw Error('Choose a JSON file smaller than 1 MB.');const value=JSON.parse(await file.text()),items=Array.isArray(value.macros)?value.macros:[value];if(!items.length||items.length>100)throw Error('Import 1–100 macros at once.');const imported=items.map(item=>{const macro=clone(item);delete macro.onboardUpload;delete macro.onboardSlot;return validateMacro({...macro,id:crypto.randomUUID(),repeatCount:Number(item.repeatCount??1),updatedAt:new Date().toISOString()});});if(!await guardMacro())return;await persistMacros(current=>[...current,...imported]);await selectMacro(imported[0].id,true);toast(imported.length+' macro(s) imported and saved on PC.');}catch(error){toast(error.message,true);}finally{event.target.value='';}};
$('read-macro-slot').onclick=async()=>{if(!state.status.connected||!await guardMacro())return;const slot=Number($('macro-slot').value),device=macroDeviceIdentity(),editor=macroEditor,revision=macroRevision;try{$('read-macro-slot').disabled=true;$('slot-status').textContent='Reading slot '+(slot+1)+'…';const result=await api('/api/macros/slot?slot='+slot);if(device!==macroDeviceIdentity())throw Error('The selected mouse changed. Read again.');await inspectMacroSlotAssociation(slot,result,device);if(device!==macroDeviceIdentity())throw Error('The selected mouse changed. Read again.');if(editor!==macroEditor||revision!==macroRevision||slot!==Number($('macro-slot').value))throw Error('Editor changed; read the slot again.');if(!result.erased&&!Array.isArray(result.decoded?.macro)){state.slotRead=result;$('slot-status').textContent='Slot '+(slot+1)+' could not be decoded. The existing editor has been preserved.';toast(result.decodeError||'Unable to decode this slot.',true);return;}macroEditor++;state.selected=null;state.steps=[];state.events=clone(result.decoded?.macro||[]);state.slotRead={...result,index:slot};state.macroDirty=false;$('macro-name').value='Onboard slot '+(slot+1);const storedCount=result.erased?1:result.decoded?.repeatCount??1;$('macro-repeat').value=String(storedCount);$('macro-playback').value=storedCount>1?'count':'once';syncMacroPlayback();renderMacros();renderSteps();setStepTypes();$('slot-status').textContent=result.erased?'Slot '+(slot+1)+' is erased · No stored sequence.':'Slot '+(slot+1)+' read · '+state.events.length+' events · Not saved on PC.';}catch(error){toast(error.message,true);$('slot-status').textContent='Could not read slot '+(slot+1)+'.';}finally{$('read-macro-slot').disabled=!state.status.connected;}};
$('macro-slot').onchange=()=>{$('slot-status').textContent='Selected slot '+(Number($('macro-slot').value)+1)+' · Read to inspect its sequence.';};
$('macro-slot').closest?.('details')?.addEventListener('toggle',()=>{if($('macro-slot').closest('details').open)refreshMacroSlots().catch(error=>toast(error.message,true));});
$('upload-macro').onclick=async()=>{if(!can('macros')||macroUploadBusy)return;macroUploadBusy=true;$('upload-macro').disabled=true;try{const macro=draftMacro(),device=macroDeviceIdentity(),revision=macroRevision,buttons=buttonRevision,result=await prepareNamedMacro(macro,device,buttons,[]);if(result===null)return;if(device!==macroDeviceIdentity()||revision!==macroRevision||buttons!==buttonRevision)throw Error('The mouse, assignments, or macro changed while syncing. Try again.');if(result.verified!==true||!Number.isInteger(result.slot)||result.slot<0||result.slot>=20||!Array.isArray(result.canonical?.macro))throw Error('The device did not verify the prepared macro.');await rememberMacroSlot(macro,result.slot,result.canonical,device,revision,[]);if(device!==macroDeviceIdentity()||revision!==macroRevision||buttons!==buttonRevision)throw Error('The mouse, assignments, or macro changed while saving sync metadata. Try again.');$('macro-slot').value=String(result.slot);$('slot-status').textContent='Macro synced and verified in slot '+(result.slot+1)+'.';toast('Macro synced to the mouse and verified.');}catch(error){toast(error.message,true);}finally{macroUploadBusy=false;$('upload-macro').disabled=!can('macros');}};

function sanitizeSettings(input,baseDpi=state.status.settings?.dpi?dpiPatch(state.status.settings.dpi):null){
 if(!input||typeof input!=='object')throw Error('A profile needs a settings object.');const result={};
 if(input.dpi&&typeof input.dpi==='object'){result.dpi=dpiPatch(input.dpi);validateDpi(result.dpi);}
 // Compatibility with the first local profile format; other stages stay unchanged.
 else if(typeof input.dpi==='number'){if(!baseDpi)throw Error('Connect your mouse to import an older single-DPI profile.');result.dpi=clone(baseDpi);result.dpi.dpiArr[result.dpi.currentDpi]=input.dpi;result.dpi.dpiArr[result.dpi.currentDpi+8]=input.dpi;validateDpi(result.dpi);}
 if(input.options&&typeof input.options==='object'){const o={};for(const key of supportedOptions)if(input.options[key]!==undefined)o[key]=clone(input.options[key]);if(input.options.sleepTime?.time_24!==undefined)o.sleepTime={time_24:input.options.sleepTime.time_24};if(Object.keys(o).length){if(o.rate!==undefined&&![125,250,500,1000,2000,4000,8000].includes(o.rate))throw Error('Invalid profile polling rate.');if(o.deBounce!==undefined)bounded(o.deBounce,0,Number(caps().debounceMax??10),'Debounce');for(const key of['liftCutOff','angelSnap'])if(o[key]!==undefined)bounded(o[key],0,key==='liftCutOff'?Math.max(...liftLevels()):1,key);for(const key of['smooth','powerSaveMode'])if(o[key]!==undefined&&typeof o[key]!=='boolean')throw Error('Invalid profile sensor option.');if(o.sleepTime)bounded(o.sleepTime.time_24,0,3600,'Sleep timeout');result.options=o;}}
 const mappings=input.keyMappings||input.buttonMappings?.map(e=>e.mapping);if(mappings!==undefined){if(!Array.isArray(mappings)||mappings.length>16)throw Error('Invalid profile button assignments.');result.keyMappings=mappings.slice(0,6).map(mapping=>{if(!Array.isArray(mapping)||mapping.length!==4||mapping.some(v=>!Number.isInteger(v)||v<0||v>255))throw Error('A button assignment must contain four bytes.');if(mapping[0]===9&&(mapping[1]>2||mapping[2]>19))throw Error('Invalid macro assignment.');return clone(mapping);});}
 if(!Object.keys(result).length)throw Error('This profile contains no supported settings.');return result;
}
async function snapshotSettings(){
 const base=state.status.settings||performanceBaseline;if(!base&&!dpiDraft)throw Error('Read device settings before saving a profile.');const options={};for(const key of supportedOptions)if(base?.options?.[key]!==undefined)options[key]=clone(base.options[key]);if(base?.options?.sleepTime?.time_24!==undefined)options.sleepTime={time_24:base.options.sleepTime.time_24};Object.assign(options,editorOptions());
 const keyMappings=clone(base?.keyMappings?.slice(0,6));if(keyMappings)for(const index of dirtyButtons){const mapping=await mappingFor(index);if(mapping)keyMappings[index]=mapping;}
 return sanitizeSettings({...(dpiDraft?{dpi:dpiDraft}:{}),...(Object.keys(options).length?{options}:{}),...(keyMappings?{keyMappings}:{})});
}
let profileMutation=Promise.resolve();
function persistProfiles(update){const operation=profileMutation.then(async()=>{const next=typeof update==='function'?update(state.profiles):update;await api('/api/profiles','PUT',{profiles:next});state.profiles=next;renderProfiles();});profileMutation=operation.catch(()=>{});return operation;}
async function loadProfile(profile){if((performanceDirty||dirtyButtons.size)&&!await discard('Loading this local profile replaces the current DPI, performance, and button drafts.'))return;try{const device=macroDeviceIdentity(),baseDpi=state.status.settings?.dpi?dpiPatch(state.status.settings.dpi):null,settings=sanitizeSettings(profile.settings,baseDpi);resetMacroAssignmentDraftState();performanceRevision++;performanceDirty=false;performanceOrigin=null;performanceBaseline=clone(state.status.settings);dpiDraft=baseDpi;syncRates();syncOptions();renderDpiStages();buttonRevision++;dirtyButtons.clear();buttonDrafts.clear();buttonsOrigin=null;syncButtons();if(settings.dpi)dpiDraft=clone(settings.dpi);if(settings.options){const o=settings.options;if(o.rate!==undefined){if(!Array.from($('polling').options).some(option=>option.value===String(o.rate)))$('polling').add(new Option(String(o.rate),String(o.rate)));$('polling').value=String(o.rate);}for(const[id,key]of Object.entries(optionFields)){const value=key==='sleepTime'?o.sleepTime?.time_24:o[key];if(value!==undefined)$(id).value=String(value);}}
 if(settings.keyMappings)settings.keyMappings.forEach((mapping,index)=>{renderMapping(index,mapping);buttonDrafts.set(index,clone(mapping));dirtyButtons.add(index);});if(dirtyButtons.size)buttonsOrigin=device;if(settings.dpi||settings.options)markPerformance();renderDpiStages();syncButtons();navigate('performance');toast('Profile loaded as a draft. Choose Apply when ready.');}catch(error){toast(error.message,true);}}
async function applyProfile(profile){if(performanceBusy)return;const device=macroDeviceIdentity();if(!device)return;performanceBusy=true;renderStatus();try{if((performanceDirty||dirtyButtons.size)&&!await discard('Applying this profile replaces your current editor drafts and writes its saved settings to the mouse.'))return;if(device!==macroDeviceIdentity())throw Error('The selected mouse changed. Choose the profile again.');const revision=performanceRevision,buttons=buttonRevision,settings=sanitizeSettings(profile.settings),request={device};if(settings.dpi){if(!can('dpi'))throw Error('DPI writing is unavailable for this connection.');request.dpi=settings.dpi;}if(settings.options){if(!can('options'))throw Error('Performance writing is unavailable for this connection.');if(settings.options.rate!==undefined&&!caps().pollingRates?.includes(settings.options.rate))throw Error('This profile uses a polling rate unavailable in the current connection mode.');request.options=settings.options;}if(settings.keyMappings?.length){if(!can('buttons'))throw Error('Button writing is unavailable for this connection.');request.buttonMappings=settings.keyMappings.map((mapping,index)=>({index,mapping})).filter(entry=>!same(entry.mapping,state.status.settings?.keyMappings?.[entry.index]));if(!request.buttonMappings.length)delete request.buttonMappings;}if(device!==macroDeviceIdentity())throw Error('The selected mouse changed. Choose the profile again.');await api('/api/settings','POST',request);if(revision===performanceRevision){performanceRevision++;performanceDirty=false;performanceOrigin=null;}if(buttons===buttonRevision){buttonRevision++;dirtyButtons.clear();buttonDrafts.clear();buttonsOrigin=null;resetMacroAssignmentDraftState();}await refresh();performanceBaseline=clone(state.status.settings);toast('Profile applied and verified on device.');}catch(error){toast(error.message,true);}finally{performanceBusy=false;renderStatus();}}
function renderProfiles(){
 const root=$('profile-list');root.replaceChildren();$('metric-profiles').textContent=String(state.profiles.length);if(!state.profiles.length)empty(root,'Save your current setup to keep a local copy.');
 state.profiles.forEach(profile=>{const card=element('article',undefined,'card profile-card'),dpi=profile.settings?.dpi,active=typeof dpi==='number'?dpi:dpi?.dpiArr?.[dpi.currentDpi||0];card.append(element('p','LOCAL PROFILE','eyebrow'),element('h2',profile.name),element('p',(active||'Unknown')+' DPI · '+(profile.settings?.options?.rate||'Unknown')+' Hz'),element('p',(dpi?.currentDPIMax?dpi.currentDPIMax+' DPI stages · ':'')+(profile.settings?.keyMappings?'Button assignments included':'Performance settings'),'fine'));
 const actions=element('div',undefined,'card-actions wrap'),apply=button('Apply to device',()=>applyProfile(profile),'primary');apply.dataset.deviceWrite='true';apply.disabled=performanceBusy||!state.status.connected;actions.append(button('Load draft',()=>loadProfile(profile)),apply,button('Export',()=>downloadJson({format:'r2-profiles',version:2,profiles:[profile]},profile.name),'text-button'),button('Delete',async()=>{try{await persistProfiles(current=>current.filter(p=>p.id!==profile.id));toast('Local profile deleted.');}catch(error){toast(error.message,true);}},'text-button danger'));card.append(actions);root.append(card);});
}
 $('save-profile').onclick=async()=>{try{const name=$('profile-name').value.trim();if(!name||name.length>80)throw Error('Enter a profile name of 1–80 characters.');const settings=await snapshotSettings(),profile={id:crypto.randomUUID(),name,settings,model:caps().model||state.status.device?.model||'R2',variant:caps().variant||state.status.device?.variant,dpiStages:stageLimit(),updatedAt:new Date().toISOString()};await persistProfiles(current=>[...current,profile]);$('profile-name').value='';toast('Complete setup saved on this PC.');}catch(error){toast(error.message,true);}};
$('import-profile').onclick=()=>$('profile-file').click();$('profile-file').onchange=async event=>{try{const file=event.target.files[0];if(!file)return;if(file.size>1000000)throw Error('Choose a JSON file smaller than 1 MB.');const data=JSON.parse(await file.text()),items=Array.isArray(data.profiles)?data.profiles:[data];if(!items.length||items.length>100)throw Error('Import 1–100 profiles at once.');const imported=items.map(item=>{if(typeof item.name!=='string'||!item.name.trim()||item.name.length>80)throw Error('Each profile needs a name of 1–80 characters.');return{id:crypto.randomUUID(),name:item.name.trim(),settings:sanitizeSettings(item.settings),model:item.model||'R2',dpiStages:item.dpiStages,updatedAt:new Date().toISOString()};});await persistProfiles(current=>[...current,...imported]);toast(imported.length+' local profile(s) imported.');}catch(error){toast(error.message,true);}finally{event.target.value='';}};
for(const id of['run-background','open-login'])$(id).onchange=()=>{preferenceRevision++;preferenceDirty=true;$('preferences-status').textContent='Unsaved desktop preferences.';};
async function loadPreferences(){try{const value=await api('/api/preferences');if(!preferenceDirty){$('run-background').checked=value.runInBackground===true;$('open-login').checked=value.openAtLogin===true;}for(const id of['run-background','open-login','save-preferences'])$(id).disabled=false;$('preferences-status').textContent='Desktop preferences are saved on this PC.';}catch{$('preferences-status').textContent='Desktop preferences are available in the native app.';}}
let preferenceSave=Promise.resolve();
$('save-preferences').onclick=()=>{const revision=preferenceRevision,values={runInBackground:$('run-background').checked,openAtLogin:$('open-login').checked};const operation=preferenceSave.then(async()=>{try{await api('/api/preferences','PUT',values);if(revision===preferenceRevision){preferenceDirty=false;$('preferences-status').textContent='Desktop preferences saved.';toast('Desktop preferences saved.');}else{$('preferences-status').textContent='Saved; newer edits remain unsaved.';toast('Preferences saved. Newer edits remain unsaved.');}}catch(error){toast(error.message,true);}});preferenceSave=operation.catch(()=>{});return operation;};
async function loadResearch(){try{const data=await api('/api/research'),parts=[];if(data.recovery)parts.push(typeof data.recovery==='string'?data.recovery:JSON.stringify(data.recovery,null,2));if(Array.isArray(data.limitations))parts.push(...data.limitations.map(value=>typeof value==='string'?value:JSON.stringify(value)));$('research-details').textContent=parts.join('\n\n')||'No additional recovery information is available.';}catch{$('research-details').textContent='Recovery information is unavailable.';}}
window.addEventListener('r2-status',event=>receiveStatus(event.detail));
let closePending=false;
window.addEventListener('r2-close-request',async()=>{if(closePending||!window.r2?.request)return;closePending=true;try{stopRecording();if(state.macroDirty||performanceDirty||dirtyButtons.size||preferenceDirty){await window.r2.request('POST','/desktop/show',null);if(!await discard('This app has unsaved edits. Save them before closing, or discard these edits.','Close R2 Control?'))return;}await window.r2.request('POST','/desktop/close',null);}catch(error){toast(error.message,true);}finally{closePending=false;}});
const quickDashboard=window.R2Dashboard.create({
 read:()=>({connected:state.status.connected===true,capabilities:caps(),dpi:dpiDraft,dirty:performanceDirty,busy:performanceBusy,canDpi:can('dpi')&&(!performanceDirty||performanceOrigin===macroDeviceIdentity()),canOptions:can('options')&&(!performanceDirty||performanceOrigin===macroDeviceIdentity()),options:{rate:$('polling').value?Number($('polling').value):null,liftCutOff:$('lod').value!==''?Number($('lod').value):null,smooth:$('smooth').value===''?null:$('smooth').value==='true'}}),
 onDpi(value){if(!can('dpi')||!dpiDraft)return;const index=dpiDraft.currentDpi;dpiDraft.dpiArr[index]=value;dpiDraft.dpiArr[index+8]=value;markPerformance();renderDpiStages();},
 onOption(key,value){if(!can('options'))return;const id={rate:'polling',liftCutOff:'lod',smooth:'smooth'}[key];if(id){$(id).value=String(value);markPerformance();}},
 onApply:applyPerformance,
 onRevert:revertPerformance
});
function syncQuickSettings(){quickDashboard.render();}
function revertPerformance(){if(performanceBusy)return;performanceRevision++;performanceDirty=false;performanceOrigin=null;renderStatus();$('performance-status').textContent='Draft changes discarded.';}
$('performance-revert').onclick=revertPerformance;
// Macro workspace assignment controls share the Button mapping drafts and writers.
let assignmentIndex=null;
const assignmentPanel=element('article',undefined,'card'),assignmentFields=element('div',undefined,'button-row'),assignmentHeading=element('h2'),assignmentStatus=element('span','','fine');
assignmentPanel.id='macro-assignment-editor';assignmentPanel.hidden=true;
const assignmentTitle=element('div',undefined,'card-title');assignmentTitle.append(assignmentHeading,button('Close',closeMacroAssignment,'text-button'));
// Named actions are a visible projection of the existing mapping controls.
// Raw slots remain explicit; selecting a saved macro never writes to the device.
let assignmentMacroPick='',assignmentMacroPickSlot='',macroPickSignature=null,macroUploadBusy=false;
const macroUploadSlots=new Map(),macroSlotOwners=new Map(),macroSlotDisplayNames=new Map(),assignmentMacroPicks=new Map(),assignmentPickDevices=new Map(),assignmentChoiceVersions=new Map(),assignmentRawChoices=new Set();let macroSlotInventory=[],macroSlotInventoryDevice=null,assignmentChoiceRevision=0;
let macroAssignmentReturn=null,macroDeleteBusy=false;
function resetMacroAssignmentDraftState(){assignmentMacroPick='';assignmentMacroPickSlot='';macroPickSignature=null;assignmentMacroPicks.clear();assignmentPickDevices.clear();assignmentChoiceVersions.clear();assignmentRawChoices.clear();macroAssignmentReturn=null;}
function bumpAssignmentChoice(index){assignmentChoiceVersions.set(index,++assignmentChoiceRevision);}
function validMacroSlot(value){if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+$/.test(value)))return null;const slot=Number(value);return Number.isInteger(slot)&&slot>=0&&slot<20?slot:null;}
function macroDeviceIdentity(){const d=state.status.device,id=d?.id??d?.mouseId;if(!state.status.connected||typeof d?.path!=='string'||!d.path||!['device','receiver'].includes(d.kind)||(typeof id!=='number'&&typeof id!=='string')||id==='')return null;return JSON.stringify([d.path,d.kind,id,d.connection??(d.is24?'2.4 GHz':'USB')]);}
// Only payload fields participate: renaming and playback preferences do not alter
// firmware events. Source identity is conservative for legacy high-level steps;
// canonical content identity is recorded from the actual compiler preview.
function macroContentIdentity(macro){const raw=Array.isArray(macro?.macro),events=raw?macro.macro:macro?.steps;if(!Array.isArray(events))return null;return JSON.stringify([Number(macro.repeatCount??1),raw?'macro':'steps',events.map(e=>e.type==='mouse_move'?[e.type,e.dx,e.dy]:[e.type,e.value,...(e.action===undefined?[]:[e.action])])]);}
function macroUploadRecord(macro){return macroUploadSlots.get(macro?.id)||macro?.onboardUpload;}
function macroOnboardSlot(macro){const record=macroUploadRecord(macro),device=macroDeviceIdentity();if(!device||record?.version!==1||record.device!==device||typeof record.contentIdentity!=='string'||record.sourceIdentity!==macroContentIdentity(macro))return null;const owner=macroSlotOwners.get(device+'|'+record.slot);if(owner!==undefined&&owner!==macro?.id)return null;return validMacroSlot(record.slot);}
function macroForSlot(slot){const matches=state.macros.filter(macro=>macroOnboardSlot(macro)===slot);return matches.length===1?matches[0]:null;}
function macroAssignmentBlocked(index){return false;}
function hasBlockedMacroAssignment(){return [...dirtyButtons].some(macroAssignmentBlocked);}
function macroPendingAssignments(id,device){return [...assignmentMacroPicks].filter(([index,picked])=>picked===id&&assignmentPickDevices.get(index)===device).map(([index])=>[index,assignmentChoiceVersions.get(index)]);}
async function rememberMacroSlot(macro,slot,canonical,device,revision,pending=macroPendingAssignments(macro.id,device)){
 const record={version:1,slot,device,sourceIdentity:macroContentIdentity(macro),contentIdentity:macroContentIdentity(canonical),revision,uploadedAt:new Date().toISOString()};
 macroSlotOwners.set(device+'|'+slot,macro.id);
 macroSlotDisplayNames.set(device+'|'+slot,{name:macro.name,contentIdentity:record.contentIdentity});
 if(macroSlotInventoryDevice===device)macroSlotInventory=macroSlotInventory.map(item=>item.index===slot?{index:slot,decoded:canonical,empty:false,erased:false,reserved:item.reserved}:item);
 // Replacing one slot retires its previous owner, including unsaved drafts.
 for(const[id,old]of macroUploadSlots)if(old.device===device&&old.slot===slot)macroUploadSlots.delete(id);
 macroUploadSlots.set(macro.id,record);
 await persistMacros(current=>current.map(item=>{const old=macroUploadRecord(item);if(item.id===macro.id)return {...item,onboardUpload:record};if(old?.device===device&&old.slot===slot){const next={...item};delete next.onboardUpload;delete next.onboardSlot;return next;}return item;}));
 // Complete only the still-current named draft after verified upload metadata saves.
 if(device===macroDeviceIdentity())for(const[index,version]of pending){
  const saved=state.macros.find(item=>item.id===macro.id),c=buttonControls[index];
  if(assignmentMacroPicks.get(index)!==macro.id||assignmentChoiceVersions.get(index)!==version||c.select.value!=='macro'||macroOnboardSlot(saved)!==slot)continue;
  c.slot.value=String(slot);c.mode.value=String(({again:1,hold:2})[saved.playbackMode]??0);
 }
 syncMacroAssignments();
 if(typeof refreshVisibleSlotLabels==='function')refreshVisibleSlotLabels();
}
async function inspectMacroSlotAssociation(slot,result,device){
 const identity=result.erased?null:macroContentIdentity(result.decoded),stale=new Map();
 for(const macro of state.macros){const record=macroUploadRecord(macro);if(record?.device===device&&record.slot===slot&&record.contentIdentity!==identity)stale.set(macro.id,JSON.stringify(record));}
 if(!stale.size)return;
 macroSlotOwners.set(device+'|'+slot,null);
 for(const id of stale.keys())macroUploadSlots.delete(id);
 await persistMacros(current=>current.map(macro=>{if(stale.get(macro.id)!==JSON.stringify(macroUploadRecord(macro)))return macro;const next={...macro};delete next.onboardUpload;delete next.onboardSlot;return next;}));
}
function appendMacroPicker(){
 const wrapper=element('label',undefined,'setting-row'),control=element('select'),note=element('small','','macro-pick-note');
 control.id='macro-assignment-macro';control.setAttribute('aria-label','Local macro');wrapper.append(element('span','Local macro'),control,note);
 const picked=()=>{if(assignmentIndex!==null)chooseNamedMacro(control.value);};
 control.addEventListener('input',picked);control.addEventListener('change',picked);
 wrapper.hidden=true;assignmentFields.append(wrapper);return {wrapper,control,note};
}
const assignmentMirrors={};
let macroPicker=null;
for(const [key,label]of [['select','Action'],['slot','Onboard macro slot'],['mode','Playback mode'],['combo','Keyboard combo']]){
 const wrapper=element('label',undefined,'setting-row'),control=element(key==='combo'?'input':'select');control.id='macro-assignment-'+key;control.setAttribute('aria-label',label);wrapper.append(element('span',label),control);assignmentFields.append(wrapper);assignmentMirrors[key]={wrapper,control};
 control.addEventListener('input',()=>editMacroAssignment(key,control.value));
 if(key!=='combo')control.addEventListener('change',()=>editMacroAssignment(key,control.value));
 if(key==='select')macroPicker=appendMacroPicker();
}
const assignmentApply=button('Apply assignments',()=>{$('apply-buttons').onclick();},'primary'),assignmentRevert=button('Revert changes',()=>{$('revert-buttons').onclick();});
assignmentApply.id='macro-apply-assignments';assignmentRevert.id='macro-revert-assignments';
const assignmentUpload=button('Sync macro…',openAssignmentMacroUpload,'secondary');assignmentUpload.id='macro-assignment-upload';assignmentUpload.hidden=true;
const assignmentActions=element('div',undefined,'card-actions');assignmentActions.append(assignmentStatus,assignmentRevert,assignmentApply);
assignmentPanel.append(assignmentTitle,assignmentFields,assignmentActions);
const macroAssignments=window.R2Assignments.create({root:$('macro-assignment-scene'),onSelect:openMacroAssignment});
$('macro-assignment-scene').append(assignmentPanel);
const resumeMacro=button('Resume draft',openMacroEditor,'secondary full');resumeMacro.id='resume-macro';resumeMacro.hidden=true;$('macro-list').after(resumeMacro);
function assignmentText(index){
 const c=buttonControls[index],action=c.select.value;
  if(action==='macro'){const named=state.macros.find(m=>m.id===assignmentMacroPicks.get(index))||macroForSlot(Number(c.slot.value));if(named)return named.name;}
  if(action==='macro')return 'Onboard slot '+(Number(c.slot.value)+1)+' · '+({'0':'Plays once or a set number of times','1':'Repeats until pressed again','2':'Repeats while holding'}[c.mode.value]||'Unknown playback');
 if(action==='combo')return c.combo.value.trim()||'Choose keyboard combo';
 return Array.from(c.select.options).find(option=>option.value===action)?.text||'Unknown';
}
function syncMacroPicker(c,editable){
 const signature=JSON.stringify([macroDeviceIdentity(),state.macros.map(macro=>[macro.id,macro.name,macroOnboardSlot(macro),macroUploadRecord(macro),macro.onboardSlot])]);
 if(signature!==macroPickSignature){
  macroPickSignature=signature;
  const options=[new Option('Raw slot / no local macro','')];
  for(const macro of state.macros){const slot=macroOnboardSlot(macro),history=macroUploadRecord(macro)||validMacroSlot(macro.onboardSlot)!==null;options.push(new Option(macro.name+(slot===null?(history?' (sync again)':' (ready to sync)'):' (slot '+(slot+1)+')'),macro.id));}
 macroPicker.control.replaceChildren(...options);
 }
 // The pick follows the slot it points at; a hand-edited slot or a reopened panel
 // re-derives it so the picker never claims a macro the button no longer plays.
 const current=String(c.slot.value);
 assignmentMacroPick=assignmentMacroPicks.get(assignmentIndex)||'';
 if(!assignmentMacroPick){const match=macroForSlot(Number(current));assignmentMacroPick=match?match.id:'';assignmentMacroPickSlot=current;}
 macroPicker.control.value=assignmentMacroPick;
 macroPicker.control.disabled=!editable;
 const chosen=state.macros.find(macro=>macro.id===assignmentMacroPick);
 macroPicker.wrapper.hidden=true;
 macroPicker.note.hidden=true;
}
function syncMacroAssignments(){
 $('apply-buttons').disabled=performanceBusy||!can('buttons')||!dirtyButtons.size||buttonsOrigin!==macroDeviceIdentity()||hasBlockedMacroAssignment();
 $('revert-buttons').disabled=performanceBusy||!dirtyButtons.size;
 macroAssignments.render(buttonNames.map((name,index)=>({name,assignment:assignmentText(index)})),state.status.connected===true);
 if(assignmentIndex===null)return;
 const c=buttonControls[assignmentIndex],editable=can('buttons')&&!performanceBusy;
 assignmentHeading.textContent=buttonNames[assignmentIndex];
 for(const [key,{wrapper,control}]of Object.entries(assignmentMirrors)){
  const original=c[key];
  if(key==='select'){syncAssignmentAction(c,control,editable);continue;}
  if(key!=='combo'&&Array.from(control.options).map(o=>o.value+'|'+o.text).join('\n')!==Array.from(original.options).map(o=>o.value+'|'+o.text).join('\n'))control.replaceChildren(...Array.from(original.options,option=>new Option(option.text,option.value)));
  control.value=original.value;control.disabled=!editable;
  wrapper.hidden=key==='slot'?c.select.value!=='macro'||!!namedMacroForAssignment(assignmentIndex):key==='mode'?c.select.value!=='macro':key==='combo'?c.select.value!=='combo':false;
 }
 syncMacroPicker(c,editable);
 assignmentStatus.textContent=dirtyButtons.size?dirtyButtons.size+' pending assignment'+(dirtyButtons.size===1?'':'s'):state.status.connected?'Assignments read from device.':'Connect your mouse to edit assignments.';
 assignmentApply.disabled=!editable||!dirtyButtons.size||buttonsOrigin!==macroDeviceIdentity();assignmentRevert.disabled=performanceBusy||!dirtyButtons.size;
}
function editMacroAssignment(key,value,keepMacro=false){
 if(assignmentIndex===null||performanceBusy||!can('buttons'))return;
 if(key==='select'&&value.startsWith('local:')){chooseNamedMacro(value.slice(6));return;}
 bumpAssignmentChoice(assignmentIndex);
 if(!keepMacro&&(key==='slot'||key==='select')){assignmentMacroPicks.delete(assignmentIndex);assignmentPickDevices.delete(assignmentIndex);if(key==='slot'||value==='macro')assignmentRawChoices.add(assignmentIndex);else assignmentRawChoices.delete(assignmentIndex);}
 const original=buttonControls[assignmentIndex][key];original.value=value;original.dispatchEvent(new Event('input',{bubbles:true}));
 if(key==='select'&&value==='macro'&&!assignmentMacroPicks.has(assignmentIndex))refreshMacroSlots().catch(error=>toast(error.message,true));
}
function clearDeletedMacroAssignments(id){
 for(const[index,picked]of assignmentMacroPicks){
  if(picked!==id)continue;
  assignmentMacroPicks.delete(index);assignmentPickDevices.delete(index);assignmentRawChoices.delete(index);
  bumpAssignmentChoice(index);
  if(dirtyButtons.has(index)){
   buttonRevision++;dirtyButtons.delete(index);buttonDrafts.delete(index);
   renderMapping(index,state.status.settings?.keyMappings?.[index]);
  }
 }
 if(macroAssignmentReturn?.id===id)macroAssignmentReturn=null;
 syncMacroAssignments();
}
function namedMacroForAssignment(index){const c=buttonControls[index];if(c.select.value!=='macro'||assignmentRawChoices.has(index))return null;return state.macros.find(m=>m.id===assignmentMacroPicks.get(index))||macroForSlot(Number(c.slot.value));}
function chooseNamedMacro(id){
 if(assignmentIndex===null||performanceBusy||!can('buttons'))return;
 const chosen=state.macros.find(m=>m.id===id);if(!chosen)return;
 const index=assignmentIndex,c=buttonControls[index],slot=macroOnboardSlot(chosen);
 assignmentRawChoices.delete(index);assignmentMacroPicks.set(index,id);assignmentPickDevices.set(index,macroDeviceIdentity());
 editMacroAssignment('select','macro',true);
 if(slot!==null&&macroForSlot(slot)?.id===id)editMacroAssignment('slot',String(slot),true);
 editMacroAssignment('mode',String(({again:1,hold:2})[chosen.playbackMode]??0),true);
 syncMacroAssignments();
}
function syncAssignmentAction(c,control,editable){
 const options=[],current=namedMacroForAssignment(assignmentIndex),counts=new Map();
 if(!c.select.value||c.select.value==='custom'){const placeholder=new Option(c.select.value==='custom'?'Keep current assignment':'Choose action…',c.select.value);placeholder.disabled=true;options.push(placeholder);}
 for(const option of c.select.options)if(option.value&&option.value!=='custom'&&option.value!=='macro')options.push(new Option(option.text,option.value));
 for(const macro of state.macros){const count=(counts.get(macro.name)||0)+1;counts.set(macro.name,count);options.push(new Option(macro.name+(count>1?' ('+count+')':''),'local:'+macro.id));}
 options.push(new Option('Other macro slot…','macro'));
 const signature=list=>Array.from(list,o=>[o.value,o.text,!!o.disabled]);
 if(JSON.stringify(signature(control.options))!==JSON.stringify(signature(options)))control.replaceChildren(...options);
 control.value=current?'local:'+current.id:c.select.value;control.disabled=!editable;
}
async function openAssignmentMacroUpload(){
 const index=assignmentIndex,id=assignmentMacroPicks.get(index),device=macroDeviceIdentity(),version=assignmentChoiceVersions.get(index);
 if(!id||!await guardMacro())return;
 if(index!==assignmentIndex||assignmentMacroPicks.get(index)!==id||device!==macroDeviceIdentity()||version!==assignmentChoiceVersions.get(index))return;
 macroAssignmentReturn={index,id,device,version};
 await selectMacro(id,true);
 const transfer=$('macro-slot').closest?.('details');if(transfer)transfer.open=true;
 $('slot-status').textContent='Choose a slot, then upload. Return to assignments to apply '+(state.macros.find(m=>m.id===id)?.name||'this macro')+'.';
}
function openMacroAssignment(index){if(!Number.isInteger(index)||!buttonControls[index])return;assignmentIndex=index;assignmentMacroPick='';assignmentPanel.hidden=false;syncMacroAssignments();assignmentMirrors.select.control.focus();}
function closeMacroAssignment(){assignmentIndex=null;assignmentPanel.hidden=true;}
// Back and the resume shelf preserve unsaved editor work.
function openMacroEditor(){closeMacroAssignment();resumeMacro.hidden=true;$('macros').classList.add('macro-editing');}
function backToMacroAssignments(){stopRecording();$('macros').classList.remove('macro-editing','editor-expanded');resumeMacro.hidden=!(state.macroDirty||state.slotRead||(!state.selected&&$('macro-name').value.trim()));const returning=macroAssignmentReturn;macroAssignmentReturn=null;if(returning&&returning.device===macroDeviceIdentity()&&assignmentMacroPicks.get(returning.index)===returning.id)openMacroAssignment(returning.index);else syncMacroAssignments();}
$('macro-back').onclick=backToMacroAssignments;
$('macro-search').addEventListener('input',renderMacros);
async function initialize(){
 renderStatus();renderMacros();renderSteps();renderProfiles();setStepTypes();
 await Promise.allSettled([refresh(),loadResearch(),loadPreferences(),(async()=>{try{const data=await api('/api/macros');state.macros=Array.isArray(data)?data:data.macros||[];renderMacros();syncMacroAssignments();}catch(error){toast(error.message,true);}})(),(async()=>{try{const data=await api('/api/profiles');state.profiles=Array.isArray(data)?data:data.profiles||[];renderProfiles();}catch(error){toast(error.message,true);}})()]);
 if(!window.r2){try{const events=new EventSource('/api/events');events.onmessage=event=>{try{receiveStatus(JSON.parse(event.data));}catch{}};events.addEventListener('status',event=>{try{receiveStatus(JSON.parse(event.data));}catch{}});}catch{}}
}
initialize();
