const DATABASE = 'terminal-v4-supervised-input-lock-v1';

export function supervisedInputTransaction(callback) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let open;
    try { open = indexedDB.open(DATABASE, 1); } catch { reject(new Error('Input recovery coordination is unavailable.')); return; }
    const fail = () => { if (!finished) { finished = true; reject(new Error('Input recovery coordination is unavailable.')); } };
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('guard')) open.result.createObjectStore('guard'); };
    open.onblocked = fail;
    open.onerror = fail;
    open.onsuccess = () => {
      const db = open.result;
      if (finished) { db.close(); return; }
      db.onversionchange = () => db.close();
      let transaction, result, failure;
      try {
        transaction = db.transaction('guard', 'readwrite');
        const request = transaction.objectStore('guard').get('lock');
        request.onsuccess = () => {
          try { result = callback(); } catch (error) { failure = error; transaction.abort(); }
        };
      } catch { db.close(); fail(); return; }
      transaction.oncomplete = () => { db.close(); if (!finished) { finished = true; resolve(result); } };
      transaction.onabort = transaction.onerror = () => { db.close(); if (!finished) { finished = true; reject(failure || new Error('Input recovery coordination is unavailable.')); } };
    };
  });
}
