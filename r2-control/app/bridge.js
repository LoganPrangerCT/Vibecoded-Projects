(() => {
  const pending = new Map();
  const pendingWrites = new Map();
  let sequence = 0;
  const cleanup = (id, entry) => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    pending.delete(id);
    if (entry.writeKey && pendingWrites.get(entry.writeKey) === entry.promise) pendingWrites.delete(entry.writeKey);
  };
  window.r2 = Object.freeze({
    request(method, path, data) {
      method = String(method).toUpperCase();
      const readOnly = method === 'GET' || method === 'HEAD';
      let writeKey, serialized;
      const id = ++sequence;
      try {
        if (!readOnly) {
          writeKey = JSON.stringify({ method, path, data: data ?? null });
          if (pendingWrites.has(writeKey)) return pendingWrites.get(writeKey);
        }
        serialized = JSON.stringify({ id, method, path, data: data ?? null });
        // Match the native IPC byte limit before registering a pending write.
        // UTF-8 can take several bytes per character in imported collections.
        if (new TextEncoder().encode(serialized).byteLength > 1024 * 1024) {
          throw new Error('This collection is too large to save (maximum 1 MiB per request). Remove some items or import a smaller collection, then try again.');
        }
      } catch (error) { return Promise.reject(error); }
      let resolve, reject;
      const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
      const entry = { resolve, reject, promise, writeKey, timer: null };
      pending.set(id, entry);
      if (writeKey) pendingWrites.set(writeKey, promise);
      // A write can continue in Rust after the webview stops waiting. Never
      // imply that it failed, or permit a duplicate retry, based on a JS timer.
      if (readOnly) entry.timer = setTimeout(() => {
        cleanup(id, entry);
        reject(new Error('This read has not completed. The desktop service may be unavailable.'));
      }, 60000);
      try { window.ipc.postMessage(serialized); }
      catch (error) { cleanup(id, entry); reject(error); }
      return promise;
    }
  });
  window.__r2Resolve = response => {
    const entry = pending.get(response.id);
    if (!entry) return;
    cleanup(response.id, entry);
    response.ok ? entry.resolve(response.data) : entry.reject(new Error(response.error || 'The command failed.'));
  };
})();
