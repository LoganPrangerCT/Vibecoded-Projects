(async () => {
  // Runs inside the already-hidden native webview. No browser, window-show,
  // preferences, onboard profile switch, or hardware mutation is requested.
  const failures = [], checks = [], skipped = [], localRoundtrips = [];
  const request = (method, path, data) => window.r2.request(method, path, data);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const check = (condition, message) => {
    checks.push({ name: message, ok: !!condition });
    if (!condition) failures.push(message);
  };
  const waitFor = async (read, label, limit = 2500) => {
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for ' + label);
  };
  const run = async (name, action) => {
    try { await action(); }
    catch (error) { check(false, name + ': ' + error.message); }
  };
  const capture = name => run('Hidden capture: ' + name, async () => {
    // Capture settled UI, after the brief reduced-motion-aware view transition.
    await new Promise(resolve=>setTimeout(resolve,220));
    await request('POST', '/test/capture', { name });
    check(true, 'Hidden native view captured: ' + name);
  });
  const field = (id, value) => {
    const input = document.getElementById(id);
    if (!input) throw new Error('Missing field #' + id);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input;
  };
  const nav = view => {
    const control = document.querySelector('nav [data-view="' + view + '"]');
    if (!control) throw new Error('Missing navigation ' + view);
    control.click();
    check(document.querySelectorAll('.view.active').length === 1 && document.getElementById(view)?.classList.contains('active'), 'Navigation: ' + view);
    check(document.querySelectorAll('nav [aria-current="page"]').length === 1 && document.querySelector('nav [aria-current="page"]') === control, 'Navigation exposes the active section: ' + view);
  };

  check(typeof window.r2?.request === 'function', 'Native IPC bridge');
  if (typeof window.r2?.request !== 'function') throw new Error('Native bridge is unavailable');
  check(document.title.includes('R2'), 'Native document title');
  let status = await request('GET', '/api/status');
  // A cold helper first publishes its receiver with ID zero, then identifies
  // the mouse asynchronously. Allow that real startup sequence to complete.
  const identificationDeadline = Date.now() + 12000;
  while (!(status.connected && status.settings) && Date.now() < identificationDeadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    status = await request('GET', '/api/status');
  }
  check(status?.backend === 'Rust', 'Read-only status comes from Rust');
  check(typeof status?.connected === 'boolean', 'Status has an explicit connection state');
  const research = await request('GET', '/api/research');
  check(/native/i.test(research?.recovery?.shell || ''), 'Native desktop shell metadata');
  await run('Logo asset', async () => {
    const logo = document.querySelector('.brand-mark');
    await waitFor(() => logo?.complete && logo.naturalWidth > 0, 'embedded PNG logo');
    check(true, 'Embedded PNG logo decodes');
  });
  check(document.querySelector('link[rel="icon"]')?.getAttribute('href')?.includes('favicon'), 'Favicon asset is linked');
  check(document.querySelector('script[src="main.js"]'), 'Production UI script is loaded');
  check(document.querySelectorAll('nav [data-view]').length===5&&!document.querySelector('nav [data-view="buttons"]')&&!document.getElementById('buttons'),'One Button mapping destination replaces the two assignment pages');
  check(document.querySelector('nav [data-view="macros"]').textContent.includes('Button mapping'),'Unified assignment navigation is named Button mapping');
  for (const view of ['overview', 'performance', 'macros', 'profiles', 'diagnostics']) nav(view);
  nav('overview');
  check(document.querySelector('#overview h1')?.textContent.trim().length > 0, 'Overview heading is rendered');
  await run('Actual mouse artwork', async () => {
    const photo = document.querySelector('#overview img.device-photo');
    await waitFor(() => photo?.complete && photo.naturalWidth === 200 && photo.naturalHeight === 288, 'original R2 mouse PNG');
    check(photo.getAttribute('src') === 'assets/r2-mouse.png' && photo.alt.includes('R2'), 'Overview uses the original R2 mouse image');
  });
  await waitFor(() => document.getElementById('connection')?.textContent.trim(), 'connection label');
  check(!/undefined|null|NaN/.test(document.getElementById('connection').textContent), 'Overview has no invented or malformed connection value');
  if (status.connected && Number.isFinite(status.device?.battery)) {
    check(document.getElementById('battery-level').textContent === status.device.battery + '%', 'Overview shows the actual device-reported battery');
    check(document.getElementById('side-status').textContent.includes(status.device.battery + '%'), 'Battery is available across panels in the sidebar');
    window.dispatchEvent(new CustomEvent('r2-status', { detail: { ...status, connected: false, device: { ...status.device, online: false } } }));
    check(document.getElementById('battery-meter').hidden && document.getElementById('battery-level').textContent === 'Unavailable', 'Offline state hides stale battery values');
    window.dispatchEvent(new CustomEvent('r2-status', { detail: status }));
    check(document.getElementById('battery-level').textContent === status.device.battery + '%', 'Battery returns when the online status is restored');
  }
  if (status.connected) {
    const malformedBattery = { ...status, device: { ...status.device, online: true, battery: 101 } };
    window.dispatchEvent(new CustomEvent('r2-status', { detail: malformedBattery }));
    const batteryLabel = [...document.querySelectorAll('#helper-details dt')].find(item => item.textContent === 'Battery');
    check(document.getElementById('battery-level').textContent === 'Unavailable' && batteryLabel?.nextElementSibling?.textContent === 'Unknown', 'Overview and Diagnostics reject out-of-range battery telemetry consistently');
    window.dispatchEvent(new CustomEvent('r2-status', { detail: status }));
  }
  await capture('overview');
  if (status.settings && status.capabilities?.dpi && status.capabilities?.options) await run('Dashboard draft controls', async () => {
    const original = status.settings.dpi.dpiArr[status.settings.dpi.currentDpi];
    const chosen = original === 800 ? 1600 : 800;
    field('quick-dpi-value', String(chosen));
    check(document.querySelector('#dpi-stages [data-stage="'+status.settings.dpi.currentDpi+'"] input[type="number"]').value === String(chosen), 'Dashboard sensitivity edits the real active stage draft');
    const rate = [...document.querySelectorAll('#quick-polling button')].find(button => Number(button.dataset.value) !== status.settings.options.rate);
    rate?.click();
    check(!!rate && document.getElementById('polling').value === rate.dataset.value, 'Dashboard polling uses the shared performance draft');
    check(!document.getElementById('quick-apply').disabled, 'Saving becomes available for draft changes');
    const unchanged = await request('GET', '/api/status');
    check(equal(unchanged.settings, status.settings), 'Dashboard edits do not write hardware before Save');
    document.getElementById('quick-revert').click();
    check(document.getElementById('quick-dpi-value').value === String(original) && document.getElementById('quick-apply').disabled, 'Revert restores device settings without a hardware write');
  });

  nav('performance');
  const current = await request('GET', '/api/status');
  if (current.settings && current.capabilities?.dpi) {
    await run('DPI stage editor', async () => {
      // REVIEW(6.1 sol): the editor renders only the enabled stages (currentDPIMax), not the whole capability range.
      const count = Number(current.capabilities.dpiStages);
      const enabled = Math.min(count, Number(current.settings.dpi.currentDPIMax) || count);
      await waitFor(() => document.querySelectorAll('#dpi-stages input[type="number"]').length === enabled, 'variant-specific enabled DPI stages');
      check(document.querySelectorAll('#dpi-stages input[type="radio"]').length === enabled, 'DPI stage active selectors match the enabled stage count');
      check(document.querySelectorAll('#dpi-stages input[type="color"]').length === enabled, 'Each enabled DPI stage has an indicator color editor');
      const values = [...document.querySelectorAll('#dpi-stages input[type="number"]')];
      check(values.every(input => Number(input.max) === Number(current.capabilities.dpiMax)), 'DPI editors use the actual variant limit');
      check(values.every(input => Number(input.step) === 50), 'DPI editors use source increments');
      const active = document.querySelector('#dpi-stages input[type="radio"]:checked');
      check(active?.id === 'dpi-active-' + current.settings.dpi.currentDpi, 'Active stage reflects read-only device settings');
    });
  } else {
    skipped.push('DPI stage values: no verified configuration is currently available.');
    check(document.getElementById('apply-performance').disabled, 'Hardware apply is disabled without verified capabilities');
  }
  for (const id of ['polling', 'debounce', 'lod', 'angle', 'sleep', 'smooth']) check(!!document.getElementById(id), 'Performance control: ' + id);
  check(!document.querySelector('#performance [id*="rgb"], #performance [id*="deep-sleep"], #performance [id*="x-sensitivity"]'), 'No unsupported RGB, deep-sleep, or independent-XY controls');
  if (current.settings && current.capabilities?.liftOffLevels) {
    const levels = [...document.getElementById('lod').options].filter(option => option.value !== '').map(option => Number(option.value));
    check(equal(levels, current.capabilities.liftOffLevels), 'Lift-off levels match verified variant capabilities');
  }
  await capture('performance');

  nav('macros');
  check(document.querySelectorAll('.button-select').length === 6, 'Six physical button editors');
  check(document.querySelectorAll('.button-extras').length === 6, 'Per-button macro/combo editors');
  check(document.querySelectorAll('[aria-label$="macro mode"] option').length === 18, 'Three macro playback modes per button');
  if (!current.connected || !current.capabilities?.buttons) check(document.getElementById('apply-buttons').disabled, 'Unverified button writes are disabled');
  if (current.capabilities?.buttons) await run('Left-button macro assignment draft',async()=>{
    field('mouse-button-0','macro');
    const row=document.getElementById('mouse-button-0').closest('.button-row');
    check(!row.querySelector('.button-extras').hidden,'Left button can be assigned to an onboard macro');
    const draft=await changedButtonMappings();
    check(draft.some(entry=>entry.index===0&&entry.mapping[0]===9),'Left-button macro produces a valid mapping draft');
    document.getElementById('revert-buttons').click();
    check((await changedButtonMappings()).length===0,'Button assignment Revert discards the draft without writing hardware');
  });

  nav('profiles');
  const onboard = document.getElementById('onboard-profile');
  check(onboard.options.length === 8 && onboard.options[0].textContent === 'Profile 1' && onboard.options[7].value === '7', 'Eight onboard profiles use friendly names and correct indices');
  for (const id of ['save-profile', 'profile-file', 'import-profile']) check(!!document.getElementById(id), 'Local profile control: ' + id);
  await capture('profiles');

  nav('macros');
  const mappingToolbar=[...document.querySelectorAll('.mapping-toolbar>button')].map(button=>button.id);
  check(mappingToolbar.indexOf('delete-macro')===mappingToolbar.indexOf('import-macro')+1&&mappingToolbar.indexOf('revert-buttons')===mappingToolbar.indexOf('delete-macro')+1,'Delete sits between Import JSON and Revert');
  check(document.getElementById('delete-macro').disabled,'Delete is disabled without a selected local macro');
  await run('Mouse-centered macro workspace',async()=>{
    check(getComputedStyle(document.querySelector('#macros .editor')).display==='none','Macro workspace opens on the mouse assignment scene');
    check(document.querySelector('#macros .library').contains(document.getElementById('new-macro'))&&!!document.getElementById('macro-search'),'Simplified library contains search and Create macro');
    const photo=document.querySelector('#macro-assignment-scene .assignment-photo');
    await waitFor(()=>photo?.complete&&photo.naturalWidth===200,'original macro workspace mouse image');
    check(photo.naturalHeight===288,'Assignment diagram uses the original R2 photograph');
    check(document.querySelectorAll('.assignment-callout').length===6&&document.querySelectorAll('.assignment-leader circle').length===6,'Six real button callouts connect to six leader endpoints');
    check(document.querySelector('.assignment-leader.underside')&&document.querySelector('.assignment-underside-note').textContent.includes('underside'),'DPI callout identifies the underside explicitly');
    const source=document.getElementById('mouse-button-2'),value=source.value;
    document.querySelector('.assignment-callout[data-assignment-index="2"]').click();
    check(!document.getElementById('macro-assignment-editor').hidden,'Mouse callout opens inline assignment controls');
    check(document.getElementById('macro-assignment-select').value===value,'Inline assignment reflects the shared physical button draft');
    await capture('macro-assignment');
    if(!current.capabilities?.buttons)check(document.getElementById('macro-assignment-select').disabled&&document.getElementById('macro-apply-assignments').disabled,'Offline inline assignment cannot write device settings');
    else{
      const originalApi=api;
      try{
        api=(path,...args)=>path==='/api/macros/slots'?Promise.resolve({device:macroDeviceIdentity(),slots:Array.from({length:20},(_,index)=>({index,empty:true,erased:true}))}):originalApi(path,...args);
        field('macro-assignment-select','macro');
        await Promise.resolve();
      }finally{api=originalApi;}
      check(source.value==='macro'&&!document.getElementById('macro-assignment-slot').closest('label').hidden,'Inline macro selection uses the existing assignment draft');
      const unchanged=await request('GET','/api/status');
      check(equal(unchanged.settings,current.settings),'Inline assignment edits do not write hardware');
      document.getElementById('macro-revert-assignments').click();
      check(source.value===value,'Inline Revert restores the shared button assignment');
    }
    document.querySelector('#macro-assignment-editor .card-title button').click();
    check(document.getElementById('macro-assignment-editor').hidden,'Assignment panel closes without replacing the macro workspace');
    check(document.getElementById('apply-buttons').getBoundingClientRect().width>0&&document.getElementById('revert-buttons').getBoundingClientRect().width>0,'Workspace Apply and Revert remain visible after closing the assignment panel');
  });
  await run('Saved macros are direct Action choices',async()=>{
    const original=await request('GET','/api/macros');
    if(window.__r2SmokeAllowLocalWrites!==true){skipped.push('Direct macro Action choices: isolated local writes required.');return;}
    const fixture={id:'ui-direct-clicker',name:'Auto Clicker',repeatCount:1,playbackMode:'hold',macro:[{type:'mouse_button',value:'left',action:'down'},{type:'delay',value:25},{type:'mouse_button',value:'left',action:'up'}]};
    try{
      const next={...original,macros:[...original.macros,fixture]};await request('PUT','/api/macros',next);state.macros=next.macros;renderMacros();
      document.querySelector('.assignment-callout[data-assignment-index="2"]').click();
      const select=document.getElementById('macro-assignment-select'),options=[...select.options];
      check(options.some(option=>option.value==='local:'+fixture.id&&option.text==='Auto Clicker'),'A saved Auto Clicker appears directly in the Action dropdown');
      check(!options.some(option=>/Unknown.*preserved|^Onboard macro$/.test(option.text)),'Normal Action choices omit preserved-state and onboard-macro jargon');
      if(current.capabilities?.buttons){
        field('macro-assignment-select','local:'+fixture.id);
        check(document.getElementById('mouse-button-2').value==='macro'&&!document.getElementById('macro-apply-assignments').disabled,'A saved macro can be applied without a separate upload step');
        check(!document.getElementById('macro-assignment-upload')||document.getElementById('macro-assignment-upload').hidden,'Named assignment has no separate upload button');
        check(document.getElementById('macro-assignment-slot').closest('label').hidden,'Named assignment hides manual slot selection');
        // Exercise the real UI handler with strictly intercepted mutation routes.
        // No prepare/bind/settings mutation can escape to the physical mouse.
        const originalApi=api,calls=[];let full=false,preparedSlot=null;
        const stored={id:'ui-stored-clicker',name:'Stored clicker',repeatCount:1,macro:[{type:'delay',value:50}]};
        const inventory=()=>Array.from({length:20},(_,index)=>({index,empty:!full&&index!==preparedSlot,erased:!full&&index!==preparedSlot,decoded:index===preparedSlot?{repeatCount:1,macro:fixture.macro}:full?{repeatCount:1,macro:[{type:'delay',value:50+index}]}:null,fingerprint:'ui-slot-'+index,replaceable:true,reserved:full,protected:false}));
        try{
          api=async(path,method,data)=>{
            if(path==='/api/macros/slots')return{slots:inventory(),device:macroDeviceIdentity()};
            if(path==='/api/macros/prepare'){calls.push({path,data:clone(data)});if(full&&data.replaceSlot===undefined)return{needsSlot:true,slots:inventory(),device:macroDeviceIdentity()};preparedSlot=data.replaceSlot??4;return{needsSlot:false,slot:preparedSlot,canonical:{repeatCount:1,macro:fixture.macro},verified:true,reused:false,device:macroDeviceIdentity()};}
            if(path==='/api/macros/bind'){calls.push({path,data:clone(data)});return{ok:true,settings:current.settings};}
            if(method!=='GET'&&['/api/settings','/api/macros/upload','/api/profile'].includes(path))throw Error('Unexpected hardware mutation during hidden test');
            return originalApi(path,method,data);
          };
          await document.getElementById('apply-buttons').onclick();
          check(calls.length===2&&calls[0].path==='/api/macros/prepare'&&calls[1].path==='/api/macros/bind','Apply automatically prepares a named macro before binding it');
          check(equal(calls[1]?.data?.buttonMappings?.find(row=>row.index===2)?.mapping,[9,2,4,0]),'Automatic slot resolution preserves held playback and physical button index');
          check([...document.getElementById('macro-slot').options].some(option=>option.value==='4'&&option.text.includes('Auto Clicker')),'The resolved storage slot displays Auto Clicker by name');
          check(equal((await request('GET','/api/status')).settings,current.settings),'Mocked automatic assignment leaves real mouse settings unchanged');
          full=true;preparedSlot=null;state.macros.push(stored);renderMacros();calls.length=0;
          field('macro-assignment-select','local:'+fixture.id);
          const cancelApply=document.getElementById('apply-buttons').onclick();
          const picker=document.getElementById('macro-slot-picker');await waitFor(()=>picker.open,'full storage replacement picker');
          check(document.querySelectorAll('#macro-slot-choices input[type="radio"]').length===20&&document.getElementById('macro-slot-choices').textContent.includes('Stored clicker'),'Only full storage opens a replacement picker with readable macro names');
          document.getElementById('macro-slot-picker-cancel').click();await cancelApply;
          check(!calls.some(call=>call.path==='/api/macros/bind'),'Cancelling full-storage replacement does not bind a button');
          calls.length=0;
          const replaceApply=document.getElementById('apply-buttons').onclick();await waitFor(()=>picker.open,'replacement picker reopened');
          const replacement=document.querySelector('#macro-slot-choices input[value="0"]');check(!replacement.disabled,'An occupied button-bound slot can be deliberately selected for replacement');replacement.checked=true;replacement.dispatchEvent(new Event('change',{bubbles:true}));
          document.getElementById('macro-slot-picker-use').click();await replaceApply;
          check(calls.some(call=>call.path==='/api/macros/prepare'&&call.data.replaceSlot===0&&call.data.replaceFingerprint==='ui-slot-0'),'Confirmed replacement sends the selected slot and observed fingerprint');
          check(equal(calls.find(call=>call.path==='/api/macros/bind')?.data?.buttonMappings?.find(row=>row.index===2)?.mapping,[9,2,0,0]),'Full-storage replacement is verified before binding the selected slot');
        }finally{api=originalApi;}
      }
    }finally{
      document.getElementById('revert-buttons').click();await request('PUT','/api/macros',original);state.macros=original.macros;resetMacro();backToMacroAssignments();closeMacroAssignment();renderMacros();
      check(equal(await request('GET','/api/macros'),original),'Direct-action fixture restores the isolated local library');
    }
  });
  await capture('macros');
  document.getElementById('new-macro').click();
  await waitFor(()=>document.getElementById('macros').classList.contains('macro-editing'),'Create macro opens the timeline editor');
  const slots = document.getElementById('macro-slot');
  check(slots.options.length === 20 && slots.options[0].textContent.includes('Slot 1') && slots.options[19].value === '19', 'Twenty macro slots use readable labels and correct indices');
  for (const id of ['macro-repeat', 'read-macro-slot', 'upload-macro', 'export-macro', 'macro-file']) check(!!document.getElementById(id), 'Macro editor control: ' + id);
  check(!!document.querySelector('#record-macro') && !!document.querySelector('[aria-label="Mouse and keyboard recording area"]'), 'Mouse and keyboard recorder controls exist');
  if (!current.connected || !current.capabilities?.macros) check(document.getElementById('upload-macro').disabled, 'Unverified macro uploads are disabled');
  await run('Unsaved macro editor', async () => {
    const back=document.getElementById('macro-back'),editor=document.querySelector('#macros .editor');
    check(!document.getElementById('macro-editor-crumb')&&editor.getBoundingClientRect().right-back.getBoundingClientRect().right<35,'Back to assignments replaces the breadcrumb in the editor top-right');
    field('macro-name', 'Quick action');
    check(document.getElementById('macro-count-field').hidden, 'Repeat count input waits for a count playback mode');
    field('macro-playback', 'count');
    check(!document.getElementById('macro-count-field').hidden, 'Repeat count input appears for a set-number playback');
    field('macro-repeat', '2');
    check(state.macroDirty === true, 'Macro edits are tracked as unsaved');
    document.getElementById('new-macro').click();
    const discard = document.getElementById('discard-dialog');
    await waitFor(() => discard.open, 'in-window unsaved macro guard');
    check(document.getElementById('discard-title').textContent === 'Unsaved macro', 'Replacing an unsaved macro requires an editor choice');
    document.getElementById('discard-cancel').click();
    await waitFor(() => !discard.open, 'guard dismissal');
    check(document.getElementById('macro-name').value === 'Quick action', 'Keep editing preserves the unsaved sequence');
  });

  await run('Manual event authoring',async()=>{
    const panel=document.querySelector('.manual-event-add');panel.open=true;
    field('manual-event-type','key');field('manual-event-value','Ctrl+C');
    document.getElementById('add-manual-event').click();
    await waitFor(()=>!document.getElementById('add-manual-event').disabled,'manual keyboard compilation');
    check(state.events.some(event=>event.type==='keyboard'&&event.value===224&&event.action==='down')&&state.events.some(event=>event.type==='keyboard'&&event.value===6&&event.action==='up'),'Manual combo produces separate modifier/key press and release events');
    const before=clone(state.events);field('manual-event-type','delay');field('manual-event-value','125');
    document.getElementById('add-manual-event').click();
    await waitFor(()=>!document.getElementById('add-manual-event').disabled,'manual delay compilation');
    check(equal(state.events.slice(0,before.length),before)&&state.events.at(-1).type==='delay'&&state.events.at(-1).value===125,'Manual event append preserves the earlier sequence and exact delay');
    state.events=[];state.steps=[];renderSteps();panel.open=false;
  });
  await run('Mouse and keyboard recording', async () => {
    const start = document.getElementById('record-macro'), zone = document.getElementById('macro-recording-area');
    start.click();
    await waitFor(() => zone.dataset.recording === 'true', 'recording start with existing delay conversion');
    const mouse = (type, button) => zone.dispatchEvent(new MouseEvent(type, {button,bubbles:true,cancelable:true}));
    mouse('mousedown', 0);
    await new Promise(resolve => setTimeout(resolve, 30));
    mouse('mouseup', 0);
    zone.dispatchEvent(new FocusEvent('blur', {relatedTarget:start}));
    check(zone.dataset.recording === 'true', 'Left click and capture-area blur do not end recording');
    const key = (target,type,code,key,repeat=false) => target.dispatchEvent(new KeyboardEvent(type, {code,key,repeat,bubbles:true,cancelable:true}));
    key(zone,'keydown','ControlLeft','Control');key(zone,'keydown','KeyA','a');
    key(zone,'keydown','KeyA','a',true); // Native key repeat must not create another hold.
    await new Promise(resolve => setTimeout(resolve, 20));
    // Keyup normally bubbles from the focused zone to window. Dispatching on
    // window here also exercises the capture listener when the focus target
    // has already changed, without generating OS input.
    key(window,'keyup','KeyA','a');key(window,'keyup','ControlLeft','Control');
    mouse('mousedown', 2);mouse('mouseup', 2);
    const menu = new MouseEvent('contextmenu',{bubbles:true,cancelable:true});zone.dispatchEvent(menu);
    check(menu.defaultPrevented && zone.dataset.recording === 'true', 'Right-click menus are suppressed while recording');
    key(zone,'keydown','Escape','Escape');
    check(zone.dataset.recording === 'false', 'Escape explicitly stops recording');
    const compiled = await request('POST','/api/macros/preview',{macro:draftMacro()});
    const events = compiled.canonical.macro;
    for (const value of ['left','right']) check(events.some(event => event.type==='mouse_button' && event.value===value && event.action==='down') && events.some(event => event.type==='mouse_button' && event.value===value && event.action==='up'), 'Recorded '+value+' click has press and release events');
    check(events.some(event => event.type==='keyboard' && event.value===224 && event.action==='down') && events.some(event => event.type==='keyboard' && event.value===4 && event.action==='up'), 'Keyboard modifier and key holds survive Rust compilation');
    const keyboardHolds=new Map();for(const event of state.events.filter(event=>event.type==='keyboard'))keyboardHolds.set(event.value,(keyboardHolds.get(event.value)||0)+(event.action==='down'?1:-1));
    check(keyboardHolds.size===2&&[...keyboardHolds.values()].every(balance=>balance===0),'Recorded DOM keyboard holds have one matching release each, with repeated keydown ignored');
    check(compiled.durationMs >= 50 && compiled.usedBytes <= compiled.capacity, 'Recorded timing fits the actual device byte budget');
  });
  await run('Visual macro timeline editing', async () => {
    const before=draftMacro().macro;
    check(document.querySelectorAll('#macro-steps .event-keycap').length===before.filter(event=>event.type!=='delay').length,'Timeline renders each input as an event tile');
    // REVIEW(6.1 sol): recording emits delays between inputs, so the first delay sits at its own
    // sequence index instead of always at index 0 (the old "add a delay step first" UI is gone).
    const delayIndex=before.findIndex(event=>event.type==='delay');
    check(delayIndex>=0,'Recorded sequence keeps at least one editable delay');
    const firstDelay=document.querySelector('#macro-steps input[type="number"]'),delayValue=firstDelay.value;
    firstDelay.value='60';firstDelay.dispatchEvent(new Event('input',{bubbles:true}));
    check(draftMacro().macro[delayIndex].value===60,'Inline timeline delay updates the saved sequence');
    firstDelay.value=delayValue;firstDelay.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[aria-label="Edit delay '+(delayIndex+1)+'"]').click();
    // Select the first sequence step (a press) so the shared move controls address steps 1 and 2.
    (document.querySelector('#macro-steps [data-event="0"] .event-keycap')||document.querySelector('#macro-steps [data-event="0"] .event-delay-select')).click();
    document.querySelector('[aria-label="Move step 1 later"]').click();
    check(equal(draftMacro().macro.slice(0,2),[before[1],before[0]]),'Timeline moves selected events without changing their contents');
    document.querySelector('[aria-label="Move step 2 earlier"]').click();
    check(equal(draftMacro().macro,before),'Moving an event back restores the original sequence');
    const keyIndex=before.findIndex(event=>event.type==='keyboard'),keyNumber=keyIndex+1;
    document.querySelector('[data-event="'+keyIndex+'"] .event-keycap').click();
    let key=document.querySelector('#macro-inspector [aria-label="Event '+keyNumber+' key"]');
    key.value='5';key.dispatchEvent(new Event('change',{bubbles:true}));
    check(draftMacro().macro[keyIndex].value===5&&document.querySelector('[data-event="'+keyIndex+'"] .event-key-label').textContent==='B','Inspector edits update both the event and its keycap');
    key=document.querySelector('#macro-inspector [aria-label="Event '+keyNumber+' key"]');
    key.value=String(before[keyIndex].value);key.dispatchEvent(new Event('change',{bubbles:true}));
    let action=document.querySelector('#macro-inspector [aria-label="Event '+keyNumber+' action"]');
    action.value='up';action.dispatchEvent(new Event('change',{bubbles:true}));
    check(draftMacro().macro[keyIndex].action==='up'&&document.querySelector('[data-event="'+keyIndex+'"] .event-direction').textContent==='↑','Inspector preserves explicit release semantics');
    action=document.querySelector('#macro-inspector [aria-label="Event '+keyNumber+' action"]');
    action.value=before[keyIndex].action;action.dispatchEvent(new Event('change',{bubbles:true}));
    check(equal(draftMacro().macro,before),'Timeline editing can restore the complete recorded sequence');
    document.querySelector('#macro-steps .event-keycap').click();
  });
  await capture('macro-editor');
  await run('Returning from macro editor preserves the draft',async()=>{
    const original=draftMacro();
    document.getElementById('macro-back').click();
    check(!document.getElementById('macros').classList.contains('macro-editing'),'Back returns to the mouse and macro library');
    check(equal(draftMacro().macro,original.macro)&&document.getElementById('macro-name').value===original.name,'Back preserves unsaved macro events and name');
  });
  await run('Macro library save, search and reopen',async()=>{
    if(window.__r2SmokeAllowLocalWrites!==true){skipped.push('Macro library form save: isolated local writes are not enabled.');return;}
    const original=await request('GET','/api/macros');
    try{
      document.getElementById('resume-macro').click();
      check(document.getElementById('macros').classList.contains('macro-editing'),'Resume opens the preserved timeline draft');
      document.getElementById('save-macro').click();
      await waitFor(()=>state.selected&&state.macros.some(macro=>macro.id===state.selected)&&!document.getElementById('save-macro').disabled,'macro saved through actual local form');
      const selected=state.selected,name=document.getElementById('macro-name').value;
      check(!state.macroDirty&&state.macros.some(macro=>macro.id===selected),'Macro form saves its recorded sequence on the PC');
      document.getElementById('macro-back').click();
      field('macro-search','no-matching-macro-'+Date.now());
      check(document.querySelectorAll('#macro-list .library-item').length===0,'Library search filters out nonmatching macros');
      field('macro-search',name.toUpperCase());
      check(document.querySelectorAll('#macro-list .library-item').length===1,'Library search matches saved names without case sensitivity');
      document.querySelector('#macro-list .library-item').click();
      await waitFor(()=>document.getElementById('macros').classList.contains('macro-editing'),'saved macro reopened');
      check(state.selected===selected&&document.getElementById('macro-name').value===name,'Selecting a saved macro reopens its actual editor');
      document.getElementById('macro-back').click();field('macro-search','');window.scrollTo(0,0);
      await waitFor(()=>!document.getElementById('toast').classList.contains('visible'),'local save notification to settle',5500);
      // REVIEW(6.1 sol): visiting another section collapses the editor, so a later Button
      // mapping visit always starts on the main assignment screen.
      document.querySelector('#macro-list .library-item').click();
      await waitFor(()=>document.getElementById('macros').classList.contains('macro-editing'),'editor reopened for navigation checks');
      nav('performance');
      nav('macros');
      check(!document.getElementById('macros').classList.contains('macro-editing'),'Leaving Button mapping defaults the return visit to the main screen');
      await capture('macros');
      document.getElementById('delete-macro').click();
      await waitFor(()=>!state.macros.some(macro=>macro.id===selected)&&!state.selected,'toolbar delete completes');
      check(document.getElementById('delete-macro').disabled&&!document.getElementById('macros').classList.contains('macro-editing'),'Toolbar Delete removes the selected PC macro and returns to assignments');
    }finally{
      await request('PUT','/api/macros',original);
      state.macros=original.macros;state.selected=null;renderMacros();field('macro-search','');
      check(equal(await request('GET','/api/macros'),original),'Macro library restored after isolated form-save checks');
    }
  });
  await run('Macro selection releases held inputs into the source only',async()=>{
    // These fixtures exist in JavaScript memory only. No collection endpoint is
    // called, and the synthetic keyboard events never leave the hidden WebView.
    const originalMacros=state.macros, snapshot={selected:state.selected,steps:clone(state.steps),events:clone(state.events),slotRead:clone(state.slotRead),dirty:state.macroDirty,name:document.getElementById('macro-name').value,playback:document.getElementById('macro-playback').value,repeat:document.getElementById('macro-repeat').value,editing:document.getElementById('macros').classList.contains('macro-editing')};
    const source={id:'ui-smoke-held-source',name:'Smoke held source',repeatCount:1,macro:[{type:'delay',value:40}]};
    const target={id:'ui-smoke-steps-target',name:'Smoke steps target',repeatCount:1,steps:[{type:'delay',value:50}]};
    try{
      resetMacro();state.macros=[...originalMacros,source,target];renderMacros();
      const sourceButton=[...document.querySelectorAll('#macro-list .library-item')].find(item=>item.textContent.includes(source.name));
      sourceButton?.click();await waitFor(()=>state.selected===source.id,'source macro selected');
      field('macro-name','Dirty source draft');
      document.getElementById('toast').className='';
      const start=document.getElementById('record-macro'),zone=document.getElementById('macro-recording-area');start.click();
      await waitFor(()=>zone.dataset.recording==='true','source recording active');
      zone.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyA',key:'a',bubbles:true,cancelable:true}));
      const targetButton=[...document.querySelectorAll('#macro-list .library-item')].find(item=>item.textContent.includes(target.name));
      targetButton?.click();const discard=document.getElementById('discard-dialog');
      await waitFor(()=>discard.open,'discard dialog after held key and library selection');
      document.getElementById('discard-cancel').click();
      await waitFor(()=>!discard.open,'cancel held-key selection');
      const sourceA=state.events.filter(event=>event.type==='keyboard'&&event.value===4);
      check(state.selected===source.id&&sourceA.length===2&&sourceA[0].action==='down'&&sourceA[1].action==='up','Cancel keeps the source draft with its held key balanced');

      start.click();await waitFor(()=>zone.dataset.recording==='true','source recording restarted');
      zone.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyB',key:'b',bubbles:true,cancelable:true}));
      targetButton.click();await waitFor(()=>discard.open,'second discard dialog');
      document.getElementById('discard-confirm').click();
      await waitFor(()=>!discard.open&&state.selected===target.id,'confirmed steps-only target selection');
      check(state.events===null&&equal(state.steps,target.steps),'Stopping the old recording does not append a release to a steps-only target');
      check(!document.getElementById('toast').classList.contains('error'),'Switching the macro editor does not raise an event-array error');
    }finally{
      stopRecording();
      if(document.getElementById('discard-dialog')?.open)document.getElementById('discard-cancel').click();
      await Promise.resolve();
      state.macros=originalMacros;state.selected=snapshot.selected;state.steps=snapshot.steps;state.events=snapshot.events;state.slotRead=snapshot.slotRead;state.macroDirty=snapshot.dirty;
      document.getElementById('macro-name').value=snapshot.name;document.getElementById('macro-playback').value=snapshot.playback;document.getElementById('macro-repeat').value=snapshot.repeat;syncMacroPlayback();
      document.getElementById('macros').classList.toggle('macro-editing',snapshot.editing);renderMacros();renderSteps();setStepTypes();
    }
  });
  await run('Device identity and profile assignment regressions',async()=>{
    const originalApi=api,originalMacros=state.macros,originalProfiles=state.profiles,realStatus=await request('GET','/api/status'),mutations=[];
    const makeStatus=id=>{
      const value=clone(realStatus),settings=value.settings||{};
      value.connected=true;value.device={...(value.device||{}),path:'ui-smoke-'+id,kind:'device',id,connection:'USB',model:'R2'};
      value.capabilities={...(value.capabilities||{}),buttons:true,options:true,dpi:true,macros:false,pollingRates:[125,250,500,1000],dpiStages:2,dpiMax:12000,dpiMin:50,dpiStep:50,liftOffLevels:[0,1],debounceMax:10,sleep:{time_24:{max:3600}}};
      value.settings={...settings,dpi:settings.dpi||{currentDpi:0,currentDPIMax:1,dpiArr:[800,0,0,0,0,0,0,0,800,0,0,0,0,0,0,0],DPIColorArr:[0,0,0,0,0,0,0,0]},options:{rate:1000,deBounce:0,liftCutOff:0,angelSnap:0,sleepTime:{time_24:300},smooth:false,...settings.options},keyMappings:Array.from({length:6},(_,index)=>clone(settings.keyMappings?.[index]||[1,0,240+index,0]))};
      return value;
    };
    let activeStatus=makeStatus('A');const otherStatus=makeStatus('B');
    const publish=value=>window.dispatchEvent(new CustomEvent('r2-status',{detail:{...clone(value),__uiSmokeFixture:true}}));
    const quarantine=event=>{if(event.detail?.__uiSmokeFixture!==true){event.stopImmediatePropagation();event.stopPropagation();}};
    window.addEventListener('r2-status',quarantine,true);
    api=async(path,method='GET',data)=>{
      if(path==='/api/status')return clone(activeStatus);
      if(method==='GET')return originalApi(path,method,data);
      mutations.push({path,method,data:clone(data)});
      // Every mutating route is contained in this mock scope. Only the
      // expected-settings route gets a success response; prepare/bind/upload,
      // profile writes and local collection writes are rejected.
      if(path==='/api/settings'&&method==='POST')return{settings:clone(activeStatus.settings)};
      throw Error('Blocked unexpected mutation in hidden UI regression: '+method+' '+path);
    };
    try{
      publish(activeStatus);nav('performance');
      const rate=document.getElementById('polling'),nextRate=rate.value==='500'?'250':'500';field('polling',nextRate);
      activeStatus=otherStatus;publish(otherStatus);
      await document.getElementById('apply-performance').onclick();
      check(!mutations.some(call=>call.path==='/api/settings'&&call.method==='POST'),'Performance draft from device A cannot post after status identifies device B');
      publish(makeStatus('A'));document.getElementById('performance-revert').click();

      nav('macros');const mapping=document.getElementById('mouse-button-0');
      mapping.value=mapping.value==='disabled'?'right':'disabled';mapping.dispatchEvent(new Event('input',{bubbles:true}));mapping.dispatchEvent(new Event('change',{bubbles:true}));
      activeStatus=otherStatus;publish(otherStatus);await document.getElementById('apply-buttons').onclick();
      check(!mutations.some(call=>call.path==='/api/settings'&&call.method==='POST'),'Raw button draft from device A cannot post after status identifies device B');
      activeStatus=makeStatus('A');publish(activeStatus);document.getElementById('revert-buttons').click();

      // Reproduce JS-01 through the visible Action, profile Load draft,
      // discard confirmation, and Apply controls. No local collection is saved.
      const previous={id:'ui-smoke-previous',name:'Smoke Previous',repeatCount:1,macro:[{type:'keyboard',value:4,action:'down'},{type:'keyboard',value:4,action:'up'}]};
      state.macros=[...originalMacros,previous];renderMacros();syncMacroAssignments();
      document.querySelector('.assignment-callout[data-assignment-index="0"]')?.click();
      const action=document.getElementById('macro-assignment-select');action.value='local:'+previous.id;action.dispatchEvent(new Event('input',{bubbles:true}));
      const profile={id:'ui-smoke-profile-clear',name:'Smoke profile clear',settings:{keyMappings:[[9,0,1,0],...activeStatus.settings.keyMappings.slice(1)]}};
      state.profiles=[...originalProfiles,profile];renderProfiles();nav('profiles');
      const profileCard=[...document.querySelectorAll('.profile-card')].find(card=>card.querySelector('h2')?.textContent===profile.name);
      [...(profileCard?.querySelectorAll('button')||[])].find(button=>button.textContent==='Load draft')?.click();
      const discard=document.getElementById('discard-dialog');await waitFor(()=>discard.open,'profile load discard dialog');
      document.getElementById('discard-confirm').click();await waitFor(()=>!discard.open&&document.getElementById('performance').classList.contains('active'),'profile draft loaded');
      nav('macros');
      check(document.getElementById('macro-assignment-select').value==='macro','Loading a raw profile mapping clears the prior named-macro Action selection');
      mutations.length=0;await document.getElementById('apply-buttons').onclick();
      check(!mutations.some(call=>call.path==='/api/macros/prepare'||call.path==='/api/macros/bind'),'Applying a profile mapping does not prepare or bind the previously selected local macro');
      check(mutations.some(call=>call.path==='/api/settings'&&call.method==='POST'&&call.data?.buttonMappings?.some(row=>row.index===0&&equal(row.mapping,[9,0,1,0]))),'Profile Apply sends the profile raw slot mapping through the mocked settings route');
    }finally{
      api=originalApi;window.removeEventListener('r2-status',quarantine,true);
      state.macros=originalMacros;state.profiles=originalProfiles;resetMacroAssignmentDraftState();
      performanceRevision++;performanceDirty=false;performanceOrigin=null;buttonRevision++;dirtyButtons.clear();buttonDrafts.clear();buttonsOrigin=null;
      performanceBaseline=clone(realStatus.settings);dpiDraft=realStatus.settings?.dpi?dpiPatch(realStatus.settings.dpi):null;
      closeMacroAssignment();renderMacros();renderProfiles();publish(realStatus);syncRates();syncOptions();renderDpiStages();syncButtons();
      document.getElementById('performance-revert').disabled=true;nav('overview');
    }
  });
  await run('Compact desktop layout', async () => {
    const original = {width:window.innerWidth,height:window.innerHeight};
    try {
      await request('POST','/test/viewport',{width:800,height:620});
      await waitFor(()=>Math.abs(window.innerWidth-800)<2,'compact hidden WebView resize');
      for (const name of ['macros','performance','profiles','diagnostics','overview']) {
        nav(name);
        check(document.documentElement.scrollWidth<=window.innerWidth+1,'No page horizontal overflow at 800px: '+name);
        if(name==='macros'||name==='overview')await capture(name+'-compact');
      }
    } finally {
      await request('POST','/test/viewport',original);
      await waitFor(()=>Math.abs(window.innerWidth-original.width)<2,'original hidden WebView size');
    }
  });
  nav('diagnostics');
  await capture('diagnostics');

  // Local collection writes rotate .json.bak. Opt in only when the native test
  // harness has snapshotted BOTH files (and absent-file states) for restoration.
  // This is deliberately read-only in ordinary --ui-smoke runs.
  for (const key of ['macros', 'profiles']) await run('Local ' + key, async () => {
    const original = await request('GET', '/api/' + key);
    const entries = original?.[key];
    check(Array.isArray(entries), 'Local ' + key + ' collection can be read');
    if (!Array.isArray(entries)) return;
    if (window.__r2SmokeAllowLocalWrites !== true) { skipped.push(key + ': roundtrip requires harness backup of .json and .json.bak.'); return; }
    if (entries.length >= 100) { skipped.push(key + ': collection is full; no write attempted.'); return; }
    const id = 'r2-ui-smoke-' + key + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    const item = key === 'macros' ? { id, name: 'Silent UI smoke macro', repeatCount: 2, steps: [{ type: 'delay', value: 25 }] } : { id, name: 'Silent UI smoke profile', settings: { options: { rate: 1000 } } };
    const expected = { ...original, [key]: [...entries, item] };
    let writeAttempted = false;
    try {
      writeAttempted = true;
      await request('PUT', '/api/' + key, expected);
      const saved = await request('GET', '/api/' + key);
      check(equal(saved, expected), 'Local ' + key + ' roundtrip preserves the complete collection');
    } finally {
      if (writeAttempted) {
        const latest = await request('GET', '/api/' + key);
        const restore = equal(latest, expected) ? original : { ...latest, [key]: latest[key].filter(entry => entry.id !== id) };
        await request('PUT', '/api/' + key, restore);
        const restored = await request('GET', '/api/' + key);
        check(equal(restored, restore), 'Local ' + key + ' restored after roundtrip');
        localRoundtrips.push({ collection: key, restored: equal(restored, restore), concurrentChangesPreserved: !equal(restore, original) });
      }
    }
  });
  nav('overview');
  await request('POST', '/test/result', { ok: !failures.length, failures, checks, skipped, localRoundtrips, title: document.title, connected: current.connected, status: current, hardwareWrites: false, visibleWindowRequested: false, bodyText: document.body.innerText.slice(0, 5000) });
})().catch(error => window.r2.request('POST', '/test/result', { ok: false, error: String(error), hardwareWrites: false, visibleWindowRequested: false }));
