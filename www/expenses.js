/* Odo - expenses and receipt photos, kept on the phone in IndexedDB. Loaded before app.js. */
(function () {
  'use strict';

  // Categories. "covered" ones are already included in the IRS standard mileage rate, so they don't count
  // when someone deducts miles. They can still be saved (for people who track actual car expenses).
  const CATEGORIES = [
    { id: 'parking', name: 'Parking & tolls', icon: '🅿️' },
    { id: 'phone', name: 'Phone & data', icon: '📱', share: true },
    { id: 'gear', name: 'Gear (bags, mounts, chargers)', icon: '🎒' },
    { id: 'supplies', name: 'Supplies', icon: '📦' },
    { id: 'fees', name: 'Fees & subscriptions', icon: '🧾' },
    { id: 'other', name: 'Other work expense', icon: '💼' },
    { id: 'car', name: 'Gas, car wash, repairs', icon: '⛽', covered: true },
  ];

  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('odo-expenses', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('expenses', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }

  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('expenses', mode);
      const req = fn(t.objectStore('expenses'));
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  /** Shrinks a photo to at most 1600 px on the long side so receipts don't fill up the phone. */
  function shrinkPhoto(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1600;
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob((b) => resolve(b || file), 'image/jpeg', 0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  /** The part of an expense that counts as a work expense. */
  function deductible(e) {
    const cat = CATEGORIES.find((c) => c.id === e.category);
    if (cat && cat.covered) return 0;
    const share = cat && cat.share ? (e.share == null ? 100 : e.share) : 100;
    return Math.round((e.amount || 0) * share) / 100;
  }

  window.OdoExpenses = {
    CATEGORIES,
    category: (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 2],
    all: () => tx('readonly', (s) => s.getAll()).then((l) => l || []),
    put: (e) => tx('readwrite', (s) => s.put(e)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
    shrinkPhoto,
    deductible,
  };
})();
