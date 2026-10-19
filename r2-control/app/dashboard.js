(function (root) {
  'use strict';
  const byId = id => document.getElementById(id);
  function create({ read, onDpi, onOption, onApply, onRevert }) {
    let busy = false;
    const slider = byId('quick-dpi'), input = byId('quick-dpi-value');
    slider.min = '0'; slider.max = '1000'; slider.step = '1';
    function limits(state) {
      return [Number(state.capabilities.dpiMin) || 50, Number(state.capabilities.dpiMax) || 42000];
    }
    function choices(id, values, labels, selected, disabled, action) {
      const container = byId(id), signature = JSON.stringify(values);
      if (container.dataset.values !== signature) {
        container.replaceChildren(); container.dataset.values = signature;
        values.forEach((value, index) => {
          const button = document.createElement('button');
          button.type = 'button'; button.dataset.value = String(value);
          button.textContent = labels[index];
          button.onclick = () => action(value);
          container.append(button);
        });
      }
      for (const button of container.children) {
        button.disabled = disabled;
        button.setAttribute('aria-pressed', String(Number(button.dataset.value) === selected));
      }
    }
    function render() {
      const state = read(), caps = state.capabilities, [min, max] = limits(state);
      const pending = busy || state.busy;
      const enabled = !pending && state.canDpi && !!state.dpi;
      const value = state.dpi?.dpiArr?.[state.dpi.currentDpi];
      const known = Number.isFinite(value) && value > 0;
      slider.disabled = input.disabled = !enabled;
      input.min = String(min); input.max = String(max); input.step = '50';
      if (document.activeElement !== input) input.value = known ? String(value) : '';
      const position = known ? Math.max(0, Math.min(1000, Math.log(value / min) / Math.log(max / min) * 1000)) : 0;
      slider.value = String(Math.round(position));
      slider.style.setProperty('--range-fill', position / 10 + '%');
      slider.setAttribute('aria-valuetext', known ? value + ' DPI' : 'Unavailable');
      byId('quick-dpi-max').textContent = max.toLocaleString() + ' DPI';
      choices('quick-dpi-presets', [400,800,1600,3200].filter(n => n <= max), ['400','800','1600','3200'], value, !enabled, onDpi);
      const optionsEnabled = !pending && state.canOptions;
      const rates = caps.pollingRates || [];
      choices('quick-polling', rates, rates.map(String), state.options.rate, !optionsEnabled, value => onOption('rate', value));
      const levels = caps.liftOffLevels || [];
      choices('quick-lod', levels, levels.length === 3 ? ['Low','Medium','High'] : ['Low','High'], state.options.liftCutOff, !optionsEnabled, value => onOption('liftCutOff', value));
      byId('quick-smooth').checked = state.options.smooth === true;
      byId('quick-smooth').disabled = !optionsEnabled || state.options.smooth == null;
      byId('quick-apply').disabled = pending || !state.dirty || !(state.canDpi || state.canOptions);
      byId('quick-revert').disabled = pending || !state.dirty;
      byId('quick-apply').textContent = pending ? 'Saving…' : 'Save changes';
      byId('quick-status').textContent = pending ? 'Writing and checking device settings…' : state.dirty ? 'You have unsaved changes.' : state.connected ? '' : 'Connect your R2 to change device settings.';
      byId('quick-device-variant').textContent = caps.variant || 'Attack Shark R2';
    }
    slider.oninput = () => {
      const [min, max] = limits(read());
      onDpi(Math.max(min, Math.min(max, Math.round(min * Math.pow(max / min, Number(slider.value) / 1000) / 50) * 50)));
    };
    input.oninput = () => {
      const [min, max] = limits(read()), value = Number(input.value);
      if (input.value !== '' && Number.isInteger(value) && value >= min && value <= max && value % 50 === 0) onDpi(value);
    };
    input.onchange = () => {
      const [min, max] = limits(read()), value = Number(input.value);
      if (!input.value || !Number.isInteger(value) || value < min || value > max || value % 50) {
        byId('quick-status').textContent = `Enter ${min}–${max.toLocaleString()} DPI in increments of 50.`;
      }
    };
    byId('quick-smooth').onchange = event => onOption('smooth', event.target.checked);
    byId('quick-revert').onclick = onRevert;
    byId('quick-apply').onclick = async () => {
      busy = true; render();
      try { await onApply(); } finally { busy = false; render(); }
    };
    return { render };
  }
  root.R2Dashboard = { create };
})(window);
