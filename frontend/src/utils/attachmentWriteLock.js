let opening = null;

function database() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('File selection coordination is unavailable.'));
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    let settled = false;
    const request = globalThis.indexedDB.open('terminal-v4-file-selection-lock', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('lock');
    request.onerror = () => { settled = true; reject(new Error('File selection coordination is unavailable.')); };
    request.onblocked = () => { settled = true; reject(new Error('File selection coordination is blocked by another tab.')); };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
  }).catch(error => { opening = null; throw error; });
  return opening;
}

export async function withAttachmentWriteLock(action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    let result, failure;
    const transaction = db.transaction('lock', 'readwrite');
    const timeout = setTimeout(() => {
      failure = new Error('File selection coordination timed out.');
      try { transaction.abort(); } catch { /* The transaction already finished. */ }
    }, 10000);
    transaction.oncomplete = () => { clearTimeout(timeout); resolve(result); };
    transaction.onabort = () => { clearTimeout(timeout); reject(failure || new Error('File selection coordination failed.')); };
    const request = transaction.objectStore('lock').get('selection');
    request.onsuccess = () => {
      try {
        result = action();
        if (result && typeof result.then === 'function') throw new Error('File selection operation must be synchronous.');
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
  });
}
