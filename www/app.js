/* Odo - app screens. Talks to the native tracker on Android; uses sample data in a desktop browser. */
(function () {
  'use strict';

  const DEFAULT_RATE = 0.725; // IRS 2026 business standard mileage rate, $ per mile
  const RATE_KEY = 'odo.rate';
  const PERIOD_KEY = 'odo.period';

  const cap = window.Capacitor;
  const isNative = !!(cap && cap.isNativePlatform && cap.isNativePlatform());
  const PLATFORM = isNative && cap.getPlatform ? cap.getPlatform() : '';
  let nativeError = '';
  const Tracker = isNative
    ? (cap.registerPlugin ? cap.registerPlugin('OdoTracker') : cap.Plugins.OdoTracker)
    : makeMock();

  const state = {
    tab: 'trips',
    trips: [],
    status: {},
    prefs: { gigs: [], prompt: 'Was this drive for work?' },
    welcomed: safeGet('odo.welcomed') === '1',
    tips: null,          // { list: [...], count, error } once loaded
    tipBusy: false,
    expenses: [],
    expDraft: null,      // expense being added or edited in the sheet
    tipNudgeOff: safeGet('odo.tipNudgeOff') === '1',
    period: safeGet(PERIOD_KEY) || 'week',
    offset: 0,
    rate: parseFloat(safeGet(RATE_KEY)) || DEFAULT_RATE,
    openTripId: null,
    otherPurpose: false,
  };
  let leafletMap = null;
  let pollTimer = null;

  const $ = (id) => document.getElementById(id);

  // ---------- helpers ----------

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const mi = (n) => (Math.round((n || 0) * 10) / 10).toFixed(1);
  const money = (n) => (n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const monFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms || 2800);
  }

  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function monday(d) {
    const x = startOfDay(d);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }

  function range(kind, off) {
    const now = new Date();
    let s, e;
    if (kind === 'week') {
      s = monday(now); s.setDate(s.getDate() + 7 * off);
      e = new Date(s); e.setDate(e.getDate() + 7);
    } else if (kind === '2wk') {
      s = monday(now); s.setDate(s.getDate() - 7 + 14 * off);
      e = new Date(s); e.setDate(e.getDate() + 14);
    } else if (kind === 'month') {
      s = new Date(now.getFullYear(), now.getMonth() + off, 1);
      e = new Date(s.getFullYear(), s.getMonth() + 1, 1);
    } else {
      s = new Date(now.getFullYear() + off, 0, 1);
      e = new Date(s.getFullYear() + 1, 0, 1);
    }
    return { s, e };
  }

  function rangeLabel(kind, r) {
    const thisYear = new Date().getFullYear();
    if (kind === 'year') return String(r.s.getFullYear());
    if (kind === 'month') {
      return r.s.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    const last = new Date(r.e.getTime() - 86400000);
    const sameMonth = last.getMonth() === r.s.getMonth();
    let label = monFmt.format(r.s) + ' – ' + (sameMonth ? last.getDate() : monFmt.format(last));
    if (last.getFullYear() !== thisYear) label += ', ' + last.getFullYear();
    return label;
  }

  function duration(ms) {
    const m = Math.max(1, Math.round(ms / 60000));
    return m < 60 ? m + ' min' : Math.floor(m / 60) + ' hr ' + (m % 60) + ' min';
  }

  /** SVG path for a route, scaled to fit a w x h box. */
  function routeD(path, w, h, pad) {
    if (!path || path.length === 0) return '';
    const lat0 = path.reduce((a, p) => a + p[0], 0) / path.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const pts = path.map((p) => [p[1] * k, -p[0]]);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6);
    const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
    const offX = (w - spanX * scale) / 2, offY = (h - spanY * scale) / 2;
    if (pts.length === 1) {
      const cx = w / 2, cy = h / 2;
      return `M${cx - 1} ${cy}L${cx + 1} ${cy}`;
    }
    return pts.map(([x, y], i) =>
      (i ? 'L' : 'M') + ((x - minX) * scale + offX).toFixed(1) + ' ' + ((y - minY) * scale + offY).toFixed(1)
    ).join('');
  }

  function workLabel() {
    const g = state.prefs.gigs;
    return g.length ? g[0] : 'Work';
  }

  // ---------- data ----------

  async function loadTrips() {
    try {
      const r = await Tracker.getTrips();
      const list = r.json ? JSON.parse(r.json) : (r.trips || []);
      state.trips = list.slice().sort((a, b) => b.start - a.start);
    } catch (e) {
      toast('Could not load trips');
    }
    render();
  }

  async function loadStatus() {
    try {
      state.status = await Tracker.getStatus();
      nativeError = '';
    } catch (e) {
      nativeError = (e && (e.message || e.code)) || String(e);
    }
    renderChrome();
  }

  async function loadPrefs() {
    try {
      const p = await Tracker.getPrefs();
      state.prefs = { gigs: p.gigs || [], prompt: p.prompt || 'Was this drive for work?' };
    } catch (e) { /* defaults */ }
  }

  async function setTrip(id, patch) {
    const t = state.trips.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
    render();
    if (state.openTripId === id) renderSheet();
    try { await Tracker.updateTrip(Object.assign({ id }, patch)); } catch (e) { toast('Could not save that change'); }
  }

  async function savePrefs() {
    try { await Tracker.setPrefs({ gigs: state.prefs.gigs, prompt: state.prefs.prompt }); } catch (e) { toast('Could not save settings'); }
  }

  // ---------- permissions ----------

  async function request(alias) {
    try { state.status = await Tracker.requestPerm({ alias }); } catch (e) { /* user declined */ }
    renderChrome();
    if (state.tab === 'settings') render();
    return !!state.status[alias];
  }

  /** Walks through what automatic tracking needs. Returns true when everything is granted. */
  async function ensureAutoPerms() {
    const s = state.status;
    if (!s.location && !(await request('location'))) {
      toast('Odo needs location to measure miles');
      return false;
    }
    if (!state.status.background) {
      const ios = state.status.platform === 'ios' || PLATFORM === 'ios';
      toast(ios ? 'Choose “Change to Always Allow” so drives record with Odo closed'
        : 'Choose "Allow all the time" so drives record with the app closed');
      if (!(await request('background'))) {
        if (ios) {
          toast('In Settings, tap Location, then choose Always', 5000);
          await Tracker.openAppSettings();
        }
        return false;
      }
    }
    if (!state.status.activity && !(await request('activity'))) {
      toast('Physical activity lets Odo notice when you start driving');
      return false;
    }
    if (!state.status.notifications) await request('notifications');
    return true;
  }

  async function toggleAuto(on) {
    if (on && isNative && !(await ensureAutoPerms())) { render(); return false; }
    try { state.status = await Tracker.setAuto({ enabled: on }); } catch (e) { toast('Could not change that setting'); return false; }
    render();
    if (on) toast('Automatic tracking is on. Just drive.');
    return true;
  }

  // ---------- start / stop ----------

  async function onFab() {
    if (state.tab === 'expenses') { openExpense(null); return; }
    if (state.status.tracking) {
      try { await Tracker.stopTrip(); } catch (e) { /* ignore */ }
      setTimeout(() => { loadStatus(); loadTrips(); }, 600);
      return;
    }
    if (isNative && !state.status.location && !(await request('location'))) {
      toast('Odo needs location to record a drive');
      return;
    }
    if (isNative && !state.status.notifications) await request('notifications');
    try {
      state.status = await Tracker.startManual();
      renderChrome();
    } catch (e) {
      toast(e && e.message ? e.message : 'Could not start recording');
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (state.status.tracking) loadStatus(); }, 4000);
  }

  // ---------- rendering ----------

  // ---------- tips ----------

  function tipsSupported() {
    return state.status.platform === 'ios' || PLATFORM === 'ios';
  }

  async function loadTips() {
    if (!tipsSupported() || (state.tips && !state.tips.error)) return;
    try {
      const r = await Tracker.getTips();
      state.tips = { list: r.tips || [], count: r.count || 0 };
    } catch (e) {
      state.tips = { list: [], count: 0, error: true };
    }
    render();
  }

  async function buyTip(id) {
    if (state.tipBusy) return;
    state.tipBusy = true;
    render();
    try {
      const r = await Tracker.buyTip({ id });
      if (state.tips) state.tips.count = r.count || state.tips.count;
      if (r.result === 'thanked') {
        dismissTipNudge();
        toast('Thank you! Tips like yours keep Odo free.', 4000);
      } else if (r.result === 'pending') {
        toast('Your tip is waiting for approval. Thank you!', 4000);
      }
    } catch (e) {
      toast('The tip didn’t go through. You weren’t charged.', 4000);
    }
    state.tipBusy = false;
    render();
  }

  function dismissTipNudge() {
    state.tipNudgeOff = true;
    safeSet('odo.tipNudgeOff', '1');
  }

  function tipButtons() {
    const t = state.tips;
    if (!t) return '<p class="note" style="margin:10px 0 0">Loading…</p>';
    if (!t.list.length) return '<p class="note" style="margin:10px 0 0">Tips aren’t available yet.</p>';
    const icons = ['☕', '🍔', '⛽'];
    return '<div class="tip-row">' + t.list.map((p, i) =>
      `<button class="tip-btn" data-act="tip" data-id="${esc(p.id)}" type="button" ${state.tipBusy ? 'disabled' : ''}>
        <span class="tip-icon" aria-hidden="true">${icons[i] || '💚'}</span>
        <span class="tip-price">${esc(p.price)}</span>
        <span class="tip-name">${esc(p.name)}</span></button>`).join('') + '</div>';
  }

  function showWelcome() {
    return !state.welcomed && !state.status.auto && state.trips.length === 0;
  }

  function render() {
    const welcome = showWelcome();
    document.body.classList.toggle('welcoming', welcome);
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    const views = { trips: tripsView, expenses: expensesView, settings: settingsView, help: helpView };
    $('view').innerHTML = welcome ? welcomeView() : (views[state.tab] || tripsView)();
    renderChrome();
  }

  function welcomeView() {
    const ios = state.status.platform === 'ios' || PLATFORM === 'ios';
    const always = ios ? '“Change to Always Allow”' : '“Allow all the time”';
    return `<section class="welcome">
        <div class="welcome-logo" aria-hidden="true"></div>
        <h1>Odo logs your miles automatically.</h1>
        <p class="welcome-lead">After each drive, just tap <strong>Work</strong> or <strong>Personal</strong>.</p>
        <div class="welcome-demo" aria-hidden="true">
          <div class="demo-title">${esc(state.prefs.prompt)}</div>
          <div class="demo-sub">12.4 mi · 4:02 – 4:31 PM</div>
          <div class="demo-btns"><span>Work</span><span>Personal</span></div>
        </div>
        <ul class="welcome-points">
          <li>Free automatic tracking. No subscription.</li>
          <li>Your trips stay on your phone.</li>
          <li>Totals and your tax deduction add up on their own.</li>
        </ul>
        <button class="btn primary welcome-go" data-act="welcome" type="button">Get started</button>
        ${isNative ? `<p class="note welcome-note">Next, your phone asks for location. Choose ${always} so drives record with Odo closed.</p>` : ''}
      </section>`;
  }

  function renderChrome() {
    const s = state.status;
    const fab = $('fab');
    if (state.tab === 'expenses') {
      fab.hidden = false;
      fab.classList.remove('recording');
      fab.textContent = '+ Add expense';
    } else {
      fab.hidden = state.tab !== 'trips';
      fab.classList.toggle('recording', !!s.tracking);
      fab.textContent = s.tracking ? `Stop · ${mi(s.miles)} mi` : 'Start drive';
    }
    $('liveDot').hidden = !s.tracking;
  }

  function periodBar(r) {
    return '<div class="period">' + [['week', 'Week'], ['2wk', '2 weeks'], ['month', 'Month'], ['year', 'Year']]
      .map(([k, l]) => `<button data-act="period" data-k="${k}" class="${state.period === k ? 'on' : ''}" type="button">${l}</button>`)
      .join('') + `</div><div class="range">
        <button class="arrow" data-act="prev" type="button" aria-label="Previous">‹</button>
        <h2>${esc(rangeLabel(state.period, r))}</h2>
        <button class="arrow" data-act="next" type="button" aria-label="Next" ${state.offset >= 0 ? 'disabled' : ''}>›</button>
      </div>`;
  }

  // ---------- expenses ----------

  const Exp = window.OdoExpenses;
  const photoUrls = new Map(); // blob -> object URL, so photos aren't re-decoded on every render

  function photoUrl(blob) {
    if (!blob) return '';
    if (!photoUrls.has(blob)) photoUrls.set(blob, URL.createObjectURL(blob));
    return photoUrls.get(blob);
  }

  function dropPhotoUrl(blob) {
    if (blob && photoUrls.has(blob)) { URL.revokeObjectURL(photoUrls.get(blob)); photoUrls.delete(blob); }
  }

  async function loadExpenses() {
    if (!Exp) return;
    try {
      state.expenses = (await Exp.all()).sort((a, b) => b.date - a.date || b.created - a.created);
    } catch (e) {
      toast('Could not open saved expenses');
    }
    if (state.tab === 'expenses') render();
  }

  function ymd(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function expensesView() {
    const r = range(state.period, state.offset);
    const inRange = state.expenses.filter((e) => e.date >= r.s.getTime() && e.date < r.e.getTime());
    const expTotal = inRange.reduce((a, e) => a + Exp.deductible(e), 0);
    const workMiles = state.trips.filter((t) => t.type === 'work' && t.start >= r.s.getTime() && t.start < r.e.getTime())
      .reduce((a, t) => a + t.miles, 0);
    const mileage = workMiles * state.rate;

    let html = periodBar(r);
    html += `<div class="card totals">
        <div class="big">
          <div><div class="stat-label">Work expenses</div><div class="stat-value">${money(expTotal)}</div></div>
          <div class="deduction"><div class="stat-label">Total with mileage</div><div class="stat-value">${money(expTotal + mileage)}</div></div>
        </div>
        <div><div class="stat-label">Mileage deduction</div><div class="stat-value small">${money(mileage)}</div></div>
        <div><div class="stat-label">Receipts</div><div class="stat-value small">${inRange.filter((e) => e.photo).length}<span class="unit">of ${inRange.length}</span></div></div>
      </div>`;

    if (!inRange.length) {
      html += `<div class="empty"><strong>No expenses ${state.offset === 0 ? 'yet' : 'in this period'}</strong>
        Add parking, tolls, your phone bill or delivery gear, and snap the receipt.</div>`;
      if (!state.expenses.length) html += `<p class="note center">Gas, car washes and repairs are already covered by the mileage rate. <a href="#" data-act="help">Learn more</a></p>`;
      return html;
    }

    const days = new Map();
    for (const e of inRange) {
      const k = startOfDay(e.date).getTime();
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(e);
    }
    for (const [k, list] of days) {
      html += `<div class="day"><div class="day-head"><span>${esc(dayFmt.format(new Date(k)))}</span>
        <span>${money(list.reduce((a, e) => a + Exp.deductible(e), 0))}</span></div>`;
      html += list.map(expenseRow).join('');
      html += '</div>';
    }
    return html;
  }

  function expenseRow(e) {
    const cat = Exp.category(e.category);
    const ded = Exp.deductible(e);
    const thumb = e.photo
      ? `<img class="exp-thumb" src="${photoUrl(e.photo)}" alt="" />`
      : `<div class="exp-thumb exp-icon" aria-hidden="true">${cat.icon}</div>`;
    const bits = e.note ? [esc(cat.name)] : [];
    if (cat.share && e.share != null && e.share < 100) bits.push(`${e.share}% work`);
    if (cat.covered) bits.push('covered by mileage');
    if (!e.photo) bits.push('no receipt');
    const sub = bits.join(' · ');
    return `<div class="trip exp" data-act="open-exp" data-id="${esc(e.id)}" role="button" tabindex="0">
        ${thumb}
        <div class="trip-main">
          <div class="exp-title">${esc(e.note || cat.name)}</div>
          ${sub ? `<div class="trip-time">${sub}</div>` : ''}
        </div>
        <div class="trip-miles">${money(cat.covered || ded !== e.amount ? ded : e.amount)}${ded !== e.amount ? `<small>of ${money(e.amount)}</small>` : ''}</div>
      </div>`;
  }

  function openExpense(id) {
    const e = id ? state.expenses.find((x) => x.id === id) : null;
    state.openTripId = null;
    state.expDraft = e ? Object.assign({}, e) : {
      id: null, date: startOfDay(Date.now()).getTime(), amount: null, category: 'parking', share: 100, note: '', photo: null,
    };
    $('sheetBack').hidden = false;
    $('sheet').hidden = false;
    renderExpenseSheet();
  }

  /** Copies what's typed in the form into the draft, so a re-render doesn't lose it. */
  function syncDraft() {
    const d = state.expDraft;
    if (!d) return;
    const v = (id) => { const el = $(id); return el ? el.value : null; };
    const amt = v('expAmount');
    if (amt != null) d.amount = amt === '' ? null : Math.round(parseFloat(amt) * 100) / 100;
    const date = v('expDate');
    if (date) { const t = new Date(date + 'T12:00').getTime(); if (!isNaN(t)) d.date = startOfDay(t).getTime(); }
    const cat = v('expCat');
    if (cat) d.category = cat;
    const share = v('expShare');
    if (share != null && share !== '') d.share = Math.max(0, Math.min(100, Math.round(parseFloat(share))));
    const note = v('expNote');
    if (note != null) d.note = note.trim();
  }

  function renderExpenseSheet() {
    const d = state.expDraft;
    if (!d) return;
    const cat = Exp.category(d.category);
    const photo = d.photo
      ? `<button class="receipt has" data-act="photo-zoom" type="button" aria-label="Enlarge receipt"><img src="${photoUrl(d.photo)}" alt="Receipt photo" /></button>
         <div class="receipt-actions"><button class="link-btn" data-act="photo" type="button">Change photo</button>
           <button class="link-btn danger" data-act="photo-remove" type="button">Remove</button></div>`
      : `<button class="receipt" data-act="photo" type="button"><span class="receipt-icon" aria-hidden="true">📷</span>
           <span>Add receipt photo</span><small>Take a picture or pick one from your library</small></button>`;

    $('sheet').innerHTML = `<div class="grip"></div>
      <h3 style="margin-top:4px">${d.id ? 'Edit expense' : 'Add expense'}</h3>
      ${photo}
      <form id="expForm" autocomplete="off">
        <div class="field two">
          <div><label for="expAmount">Amount</label>
            <input type="number" id="expAmount" inputmode="decimal" step="0.01" min="0" placeholder="0.00" value="${d.amount == null ? '' : d.amount}" required /></div>
          <div><label for="expDate">Date</label><input type="date" id="expDate" value="${ymd(d.date)}" required /></div>
        </div>
        <div class="field"><label for="expCat">Category</label>
          <select id="expCat">${Exp.CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === d.category ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')}</select></div>
        ${cat.share ? `<div class="field"><label for="expShare">Work share of this bill (%)</label>
          <input type="number" id="expShare" inputmode="numeric" min="0" max="100" step="1" value="${d.share == null ? 100 : d.share}" />
          <p class="note" style="margin:6px 0 0">Only the part you use for work counts. If half your phone use is for work, enter 50.</p></div>` : ''}
        ${cat.covered ? `<div class="warn"><strong>Usually not deductible separately.</strong>
          If you deduct miles at the IRS rate, gas, car washes, oil and repairs are already included, so Odo doesn’t add this to your totals.
          Keep it only if you track actual car expenses instead.</div>` : ''}
        <div class="field"><label for="expNote">Note (optional)</label>
          <input type="text" id="expNote" maxlength="60" placeholder="e.g. Airport parking, Verizon bill" value="${esc(d.note || '')}" /></div>
        <div class="sheet-actions">
          ${d.id ? '<button class="btn danger" data-act="exp-delete" type="button">Delete</button>' : '<button class="btn" data-act="close" type="button">Cancel</button>'}
          <button class="btn primary" type="submit">Save</button>
        </div>
      </form>`;
  }

  async function saveExpense() {
    syncDraft();
    const d = state.expDraft;
    if (!d) return;
    if (!(d.amount > 0)) { toast('Enter the amount'); return; }
    const e = Object.assign({}, d);
    if (!e.id) { e.id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); e.created = Date.now(); }
    if (!Exp.category(e.category).share) delete e.share;
    try {
      await Exp.put(e);
    } catch (err) {
      toast('Could not save. Your phone may be low on storage.');
      return;
    }
    const old = state.expenses.find((x) => x.id === e.id);
    if (old && old.photo && old.photo !== e.photo) dropPhotoUrl(old.photo);
    state.expenses = state.expenses.filter((x) => x.id !== e.id).concat(e).sort((a, b) => b.date - a.date || (b.created || 0) - (a.created || 0));
    closeSheet();
    render();
    toast(Exp.category(e.category).covered ? 'Saved (not counted, covered by mileage)' : 'Expense saved');
  }

  async function onReceiptPicked(file) {
    if (!file || !state.expDraft) return;
    syncDraft();
    toast('Adding photo…', 1500);
    const blob = await Exp.shrinkPhoto(file);
    if (!state.expDraft) return;
    state.expDraft.photo = blob;
    renderExpenseSheet();
  }

  // ---------- help ----------

  function helpView() {
    const ios = state.status.platform === 'ios' || PLATFORM === 'ios';
    const p = esc(state.prefs.prompt);
    let html = `<button class="back-link" data-act="help-back" type="button">‹ Back</button>
      <h1 class="page-title">Help &amp; tips</h1>`;
    const sec = (title, body) => `<div class="section-title">${title}</div><div class="card help">${body}</div>`;

    html += sec('How Odo works', `<ul>
      <li>Odo notices when you start driving and records the trip on its own. You don’t need to press anything.</li>
      <li>When the drive ends, Odo asks “${p}” Tap <strong>Work</strong> or <strong>Personal</strong> on the notification, or label trips later on the Trips screen.</li>
      <li>Tap any trip to see its map, change the label, fix the miles or delete it.</li>
      <li>Your deduction is your work miles times the IRS rate (72.5¢ a mile for 2026). You can change the rate in Settings.</li></ul>`);

    html += sec('Shifts', `<ul>
      <li>Tap <strong>Start shift</strong> on the Trips screen and every drive is logged as ${esc(workLabel())} without asking.</li>
      <li>A shift ends when you tap <strong>End shift</strong>, or after 12 hours.</li>
      <li>Add names like DoorDash or Amazon Flex in <strong>Settings → Work labels</strong>. The first one is used for shifts.</li></ul>`);

    if (ios) {
      html += sec('Siri, hands-free', `<ul>
        <li>Say <strong>“Hey Siri, start shift in Odo”</strong> when you start working.</li>
        <li>Say <strong>“Hey Siri, end shift in Odo”</strong> when you’re done.</li>
        <li>“Start dash in Odo” and “End dash in Odo” work too.</li>
        <li>To start a shift automatically when you open a work app like Dasher, set up the Shortcuts automation in <strong>Settings → Start shifts from a work app</strong>.</li></ul>`);
    }

    html += sec('Getting every mile', `<ul>
      <li>Location must be set to <strong>${ios ? 'Always' : 'Allow all the time'}</strong>, with Precise Location on.</li>
      <li>Don’t swipe Odo away in the app switcher. ${ios ? 'iPhone may not wake it for your next drive if you do.' : 'Android may stop it until you open it again.'}</li>
      ${ios ? '<li>Low Power Mode can delay detection. Odo still starts the trip from where you parked.</li>' : '<li>Set battery use for Odo to <strong>Unrestricted</strong> so your phone doesn’t shut it down mid-shift.</li>'}
      <li>Forgot to label a trip? It waits on the Trips screen under “Need a label.”</li></ul>`);

    html += sec('Expenses', `<ul>
      <li>Add work costs on the <strong>Expenses</strong> tab and snap a photo of the receipt.</li>
      <li><strong>Count these:</strong> parking and tolls, the work share of your phone bill, delivery bags, phone mounts, chargers and work supplies.</li>
      <li><strong>Don’t add these if you deduct miles:</strong> gas, oil, tires, repairs, car washes, insurance and registration. The IRS mileage rate already covers them.</li>
      <li>Keep receipts for anything $75 or more, and for all lodging.</li></ul>`);

    html += sec('Your data', `<ul>
      <li>Trips, expenses and receipt photos are stored only on this phone. Odo has no account and sends nothing to us.</li>
      <li>Deleting the app deletes your data, so keep that in mind before you delete it.</li></ul>`);

    html += `<p class="note">Odo is a record-keeping tool, not tax advice. Ask a tax preparer about your situation.</p>`;
    return html;
  }

  function tripsView() {
    const r = range(state.period, state.offset);
    const inRange = state.trips.filter((t) => t.start >= r.s.getTime() && t.start < r.e.getTime());
    let work = 0, personal = 0, pending = 0;
    for (const t of inRange) {
      if (t.type === 'work') work += t.miles;
      else if (t.type === 'personal') personal += t.miles;
      else pending++;
    }

    let html = '';
    if (isNative && !state.status.auto) {
      html += `<div class="card banner"><p><strong>Automatic tracking is off</strong>Turn it on and Odo records every drive for you.</p>
        <button class="btn primary" data-act="goto-settings" type="button">Set up</button></div>`;
    }
    if (state.status.dashSupported) {
      const s = state.status;
      html += s.dashing
        ? `<div class="card dash on"><div><strong>On shift since ${esc(timeFmt.format(s.dashSince))}</strong>
            <p>Every drive is logged as ${esc(workLabel())}.</p></div>
            <button class="btn" data-act="dash" data-v="0" type="button">End shift</button></div>`
        : `<div class="card dash"><div><strong>Off shift</strong>
            <p>Start a shift and drives are logged as ${esc(workLabel())} without asking.</p></div>
            <button class="btn primary" data-act="dash" data-v="1" type="button">Start shift</button></div>`;
    }

    html += periodBar(r);

    html += `<div class="card totals">
        <div class="big">
          <div><div class="stat-label">Business miles</div><div class="stat-value">${mi(work)}<span class="unit">mi</span></div></div>
          <div class="deduction"><div class="stat-label">Est. deduction</div><div class="stat-value">${money(work * state.rate)}</div></div>
        </div>
        <div><div class="stat-label">Personal</div><div class="stat-value">${mi(personal)}<span class="unit">mi</span></div></div>
        <div><div class="stat-label">Need a label</div><div class="stat-value">${pending}<span class="unit">${pending === 1 ? 'trip' : 'trips'}</span></div></div>
      </div>`;

    if (tipsSupported() && !state.tipNudgeOff && state.trips.length >= 20 && state.tips && state.tips.list.length && !state.tips.count) {
      html += `<div class="card tip-nudge"><p><strong>Enjoying Odo?</strong>
          It’s free with no ads or subscription. A small tip helps keep it that way.</p>
        ${tipButtons()}
        <button class="link-btn" data-act="tip-later" type="button" style="margin-top:6px">Not now</button></div>`;
    }

    if (!inRange.length) {
      html += `<div class="empty"><strong>No trips ${state.offset === 0 ? 'yet' : 'in this period'}</strong>
        ${state.offset === 0 ? (state.status.auto ? 'Your next drive will show up here.' : 'Tap Start drive, or turn on automatic tracking.') : ''}</div>`;
      return html;
    }

    const days = new Map();
    for (const t of inRange) {
      const k = startOfDay(t.start).getTime();
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(t);
    }
    for (const [k, list] of days) {
      const dayWork = list.filter((t) => t.type === 'work').reduce((a, t) => a + t.miles, 0);
      html += `<div class="day"><div class="day-head"><span>${esc(dayFmt.format(new Date(k)))}</span>
        <span>${mi(dayWork)} business mi</span></div>`;
      html += list.map(tripRow).join('');
      html += '</div>';
    }
    return html;
  }

  function tripRow(t) {
    const type = t.type || 'pending';
    const chip = type === 'work'
      ? `<span class="chip">${esc(t.purpose || 'Work')}</span>`
      : type === 'personal' ? '<span class="chip personal">Personal</span>' : '<span class="chip pending">Work or personal?</span>';
    let quick = '';
    if (type === 'pending') {
      const gigs = state.prefs.gigs.length ? state.prefs.gigs : ['Work'];
      quick = '<div class="quick">' + gigs.slice(0, 3).map((g) =>
        `<button class="yes" data-act="quick" data-id="${esc(t.id)}" data-purpose="${esc(g)}" type="button">${esc(g)}</button>`
      ).join('') + `<button data-act="quick" data-id="${esc(t.id)}" data-purpose="" type="button">Personal</button></div>`;
    }
    return `<div class="trip ${type === 'pending' ? 'pending' : ''}" data-act="open" data-id="${esc(t.id)}" role="button" tabindex="0">
        <svg class="thumb ${type}" viewBox="0 0 56 42" aria-hidden="true"><path d="${routeD(t.path, 56, 42, 6)}"/></svg>
        <div class="trip-main">
          <div class="trip-time">${esc(timeFmt.format(t.start))} – ${esc(timeFmt.format(t.end))}</div>
          ${chip}
        </div>
        <div class="trip-miles">${mi(t.miles)} mi${type === 'work' ? `<small>${money(t.miles * state.rate)}</small>` : ''}</div>
        ${quick}
      </div>`;
  }

  function settingsView() {
    const s = state.status;
    let html = '';

    html += `<div class="section-title">Automatic tracking</div>
      <div class="card"><div class="row">
        <div><strong>Record drives automatically</strong><p>Odo notices when you start driving and asks “${esc(state.prefs.prompt)}” when you stop.</p></div>
        <label class="switch"><input type="checkbox" id="autoToggle" ${s.auto ? 'checked' : ''}/><span></span></label>
      </div></div>`;

    const ios = s.platform === 'ios' || PLATFORM === 'ios';
    if (nativeError) {
      html += `<div class="card banner"><p><strong>Odo’s tracker isn’t connected</strong>
        Send this to Claude: ${esc(PLATFORM)} · ${esc(nativeError)}</p></div>`;
    }
    if ((isNative || s.platform) && ios) {
      const steps = [
        ['location', 'Location', 'So Odo can measure your miles.', 'Allow'],
        ['background', 'Location: Always', 'So drives record with Odo closed. iPhone asks “Change to Always Allow?”', 'Allow'],
        ['precise', 'Precise Location', 'Exact miles instead of rough ones.', 'Open'],
        ['activity', 'Motion & Fitness', 'Notices when you start driving, using almost no battery.', 'Allow'],
        ['notifications', 'Notifications', 'For the “' + esc(state.prefs.prompt) + '” question after each drive.', 'Allow'],
      ];
      html += '<div class="section-title">Setup</div><div class="card">' + steps.map(([k, title, desc, btn]) => {
        const ok = !!s[k];
        const blocked = (k === 'background' || k === 'precise') && !s.location;
        return `<div class="row"><div class="step"><span class="check ${ok ? 'ok' : 'no'}">${ok ? '✓' : '!'}</span>
          <div><strong>${title}</strong><p>${desc}</p></div></div>
          ${ok ? '' : `<button class="btn" data-act="perm" data-k="${k}" type="button" ${blocked ? 'disabled' : ''}>${btn}</button>`}</div>`;
      }).join('') + '</div>';
      if (!s.background && s.location) {
        html += '<p class="note">If iPhone doesn’t ask, tap Allow and choose Location → Always in Settings.</p>';
      }
      html += `<div class="section-title">Start shifts from a work app</div><div class="card">
        <p class="howto-lead">Set this up once in the Shortcuts app and opening your work app (Dasher, Uber Driver, a CRM…) starts a shift. Every drive during it is logged as ${esc(workLabel())}:</p>
        <ol class="howto">
          <li>Open <strong>Shortcuts</strong>, tap <strong>Automation</strong>, then <strong>+</strong>.</li>
          <li>Choose <strong>App</strong>, pick your work app (for example <strong>Dasher</strong>), check <strong>Is Opened</strong>, and select <strong>Run Immediately</strong>.</li>
          <li>Tap <strong>Next</strong>, then <strong>New Blank Automation</strong>.</li>
          <li>Tap <strong>Add Action</strong>, search for <strong>Odo</strong>, and choose <strong>Start Shift</strong>. Tap <strong>Done</strong>.</li>
        </ol>
        <p class="note" style="margin:10px 0 0">A shift ends when you tap End shift, say “End shift in Odo,” or after 12 hours. Drives outside a shift still get the “${esc(state.prefs.prompt)}” question.</p>
      </div>`;
    } else if (isNative) {
      const steps = [
        ['location', 'Location', 'So Odo can measure your miles.', 'Allow'],
        ['background', 'Location: Allow all the time', 'So drives record with the app closed.', 'Allow'],
        ['activity', 'Physical activity', 'Notices when you start driving, using almost no battery.', 'Allow'],
        ['notifications', 'Notifications', 'For the work-or-personal question after each drive.', 'Allow'],
        ['batteryUnrestricted', 'Battery: no restrictions', 'Keeps your phone from shutting Odo down mid-shift.', 'Open'],
      ];
      html += '<div class="section-title">Setup</div><div class="card">' + steps.map(([k, title, desc, btn]) => {
        const ok = !!s[k];
        const blocked = k === 'background' && !s.location;
        return `<div class="row"><div class="step"><span class="check ${ok ? 'ok' : 'no'}">${ok ? '✓' : '!'}</span>
          <div><strong>${title}</strong><p>${desc}</p></div></div>
          ${ok ? '' : `<button class="btn" data-act="perm" data-k="${k}" type="button" ${blocked ? 'disabled' : ''}>${btn}</button>`}</div>`;
      }).join('') + '</div>';
      if (!s.batteryUnrestricted) {
        html += '<p class="note">For battery, find Odo in the list and choose “Unrestricted” or “Don’t optimize.”</p>';
      }
    }

    html += `<div class="section-title">Work labels (optional)</div><div class="card">
      <div><strong>Name your work</strong><p class="note" style="margin:4px 0 0">Add names like DoorDash, Showings or Client visits and they replace the Work button. Leave it empty to just use Work.</p></div>
      <div class="gig-list">${state.prefs.gigs.map((g, i) =>
        `<span class="gig">${esc(g)}<button data-act="del-gig" data-i="${i}" type="button" aria-label="Remove ${esc(g)}">×</button></span>`).join('')
        || '<span class="note" style="margin:0">None. Trips are labeled “Work.”</span>'}</div>
      <form class="inline-form" id="gigForm"><input type="text" id="gigInput" maxlength="24" placeholder="Add, e.g. DoorDash" />
        <button class="btn primary" type="submit">Add</button></form>
    </div>`;

    html += `<div class="section-title">Question after each drive</div><div class="card">
      <input type="text" id="promptInput" maxlength="40" value="${esc(state.prefs.prompt)}" />
      <p class="note" style="margin:8px 0 0">Shown after each drive with Work and Personal buttons.</p></div>`;

    html += `<div class="section-title">Help</div><div class="card"><div class="row">
      <div><strong>Help &amp; tips</strong><p>How Odo works, Siri commands, and what you can deduct.</p></div>
      <button class="btn" data-act="help" type="button">Open</button></div></div>`;

    if (tipsSupported()) {
      const n = state.tips ? state.tips.count : 0;
      html += `<div class="section-title">Support Odo</div><div class="card">
        <div><strong>Leave a tip</strong><p class="note" style="margin:4px 0 0">Odo is free with no ads or subscription.
          If it saves you time or money, a tip helps keep it that way. Tips don’t unlock anything.</p></div>
        ${tipButtons()}
        ${n ? `<p class="note tip-thanks">You’ve tipped ${n} time${n === 1 ? '' : 's'}. Thank you! 💚</p>` : ''}
      </div>`;
    }

    html += `<div class="section-title">Mileage rate</div><div class="card"><div class="row">
      <div><strong>Cents per business mile</strong><p>The 2026 IRS business rate is 72.5¢.</p></div>
      <input type="number" id="rateInput" step="0.5" min="0" max="200" value="${Math.round(state.rate * 1000) / 10}" style="width:96px;text-align:right" />
    </div></div>`;

    html += `<p class="note">Odo test build 0.3. Your trips stay on this phone.</p>`;
    if (!isNative) html += '<p class="dev-note">Browser preview: sample trips, no GPS.</p>';
    return html;
  }

  // ---------- trip sheet ----------

  function openTrip(id) {
    state.openTripId = id;
    state.otherPurpose = false;
    $('sheetBack').hidden = false;
    $('sheet').hidden = false;
    renderSheet(true);
  }

  function closeSheet() {
    state.openTripId = null;
    state.expDraft = null;
    if (leafletMap) { leafletMap.remove(); leafletMap = null; }
    $('sheetBack').hidden = true;
    $('sheet').hidden = true;
  }

  function renderSheet(drawMap) {
    const t = state.trips.find((x) => x.id === state.openTripId);
    if (!t) { closeSheet(); return; }
    const type = t.type || 'pending';
    const gigs = state.prefs.gigs;
    const purpose = t.purpose || '';
    const custom = state.otherPurpose || (purpose && !gigs.includes(purpose));

    const sheet = $('sheet');
    const keepMap = !drawMap && sheet.querySelector('#map');
    const mapHtml = keepMap ? '' : '<div class="map" id="map"></div>';

    const options = gigs.map((g) => `<option value="${esc(g)}" ${!custom && purpose === g ? 'selected' : ''}>${esc(g)}</option>`).join('');
    const purposeField = type !== 'work' ? '' : `<div class="field"><label for="purposeSel">Purpose</label>
        <select id="purposeSel">${options}${gigs.length ? '' : `<option value="Work" ${purpose === 'Work' || !purpose ? 'selected' : ''}>Work</option>`}
          <option value="__other" ${custom ? 'selected' : ''}>Other…</option></select>
        ${custom ? `<input type="text" id="purposeText" maxlength="40" placeholder="e.g. Supply run" value="${esc(gigs.includes(purpose) ? '' : purpose)}" style="margin-top:8px" />` : ''}
      </div>`;

    const body = `<h3>${mi(t.miles)} mi${type === 'work' ? ` <span style="color:var(--accent);font-size:17px">· ${money(t.miles * state.rate)}</span>` : ''}</h3>
      <div class="sub">${esc(dayFmt.format(t.start))} · ${esc(timeFmt.format(t.start))} – ${esc(timeFmt.format(t.end))} · ${duration(t.end - t.start)}${t.manual ? ' · started by hand' : ''}</div>
      <div class="seg">
        <button class="${type === 'work' ? 'on work' : ''}" data-act="type" data-v="work" type="button">Work</button>
        <button class="${type === 'personal' ? 'on' : ''}" data-act="type" data-v="personal" type="button">Personal</button>
      </div>
      ${purposeField}
      <div class="sheet-actions">
        <button class="btn danger" data-act="delete" type="button">Delete</button>
        <button class="btn primary" data-act="close" type="button">Done</button>
      </div>`;

    if (keepMap) {
      sheet.querySelector('#sheetBody').innerHTML = body;
    } else {
      sheet.innerHTML = `<div class="grip"></div>${mapHtml}<div id="sheetBody">${body}</div>`;
      drawRoute(t);
    }
  }

  function drawRoute(t) {
    const el = $('map');
    const path = t.path || [];
    if (leafletMap) { leafletMap.remove(); leafletMap = null; }
    if (window.L && navigator.onLine && path.length > 1) {
      try {
        leafletMap = L.map(el, { zoomControl: false, attributionControl: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19, attribution: '© OpenStreetMap',
        }).addTo(leafletMap);
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1f8a5b';
        const line = L.polyline(path, { color: accent, weight: 5, opacity: 0.9 }).addTo(leafletMap);
        L.circleMarker(path[0], { radius: 6, color: accent, fillColor: '#fff', fillOpacity: 1, weight: 3 }).addTo(leafletMap);
        L.circleMarker(path[path.length - 1], { radius: 6, color: accent, fillColor: accent, fillOpacity: 1, weight: 3 }).addTo(leafletMap);
        leafletMap.fitBounds(line.getBounds(), { padding: [24, 24] });
        setTimeout(() => leafletMap && leafletMap.invalidateSize(), 60);
        return;
      } catch (e) { /* fall back to outline */ }
    }
    el.innerHTML = `<svg class="outline" viewBox="0 0 320 220" preserveAspectRatio="xMidYMid meet"><path d="${routeD(path, 320, 220, 24)}"/></svg>`;
  }

  // ---------- events ----------

  document.addEventListener('click', async (ev) => {
    const tab = ev.target.closest('.tabs button');
    if (tab) { state.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }

    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const id = el.dataset.id;

    if (act === 'period') { state.period = el.dataset.k; state.offset = 0; safeSet(PERIOD_KEY, state.period); render(); }
    else if (act === 'prev') { state.offset--; render(); }
    else if (act === 'next') { if (state.offset < 0) state.offset++; render(); }
    else if (act === 'goto-settings') { state.tab = 'settings'; render(); window.scrollTo(0, 0); }
    else if (act === 'quick') {
      ev.stopPropagation();
      const p = el.dataset.purpose;
      setTrip(id, p ? { type: 'work', purpose: p } : { type: 'personal', purpose: '' });
    }
    else if (act === 'open') openTrip(id);
    else if (act === 'type') {
      const v = el.dataset.v;
      const t = state.trips.find((x) => x.id === state.openTripId);
      setTrip(state.openTripId, v === 'work'
        ? { type: 'work', purpose: (t && t.purpose) || workLabel() }
        : { type: 'personal', purpose: '' });
    }
    else if (act === 'delete') {
      const tid = state.openTripId;
      if (!confirm('Delete this trip?')) return;
      closeSheet();
      state.trips = state.trips.filter((x) => x.id !== tid);
      render();
      try { await Tracker.deleteTrip({ id: tid }); } catch (e) { toast('Could not delete'); }
    }
    else if (act === 'close') closeSheet();
    else if (act === 'perm') {
      const k = el.dataset.k;
      const ios = state.status.platform === 'ios' || PLATFORM === 'ios';
      if (k === 'batteryUnrestricted') {
        await Tracker.openBatterySettings();
      } else if (k === 'precise') {
        toast('Tap Location, then turn on Precise Location', 5000);
        await Tracker.openAppSettings();
      } else if (k === 'background') {
        toast(ios ? 'Choose “Change to Always Allow”' : 'Choose “Allow all the time”');
        const ok = await request('background');
        if (!ok && (ios || state.status.sdk >= 30)) {
          if (ios) toast('Tap Location, then choose Always', 5000);
          await Tracker.openAppSettings();
        }
      } else {
        const ok = await request(k);
        if (!ok) { toast('Turn it on in Odo’s app settings'); await Tracker.openAppSettings(); }
      }
      if (state.status.auto) Tracker.setAuto({ enabled: true }).catch(() => {});
    }
    else if (act === 'help') { ev.preventDefault(); state.helpFrom = state.tab === 'help' ? state.helpFrom : state.tab; state.tab = 'help'; render(); window.scrollTo(0, 0); }
    else if (act === 'help-back') { state.tab = state.helpFrom || 'trips'; render(); window.scrollTo(0, 0); }
    else if (act === 'open-exp') openExpense(id);
    else if (act === 'photo') { syncDraft(); $('receiptFile').click(); }
    else if (act === 'photo-zoom') el.classList.toggle('zoom');
    else if (act === 'photo-remove') { syncDraft(); if (state.expDraft) { state.expDraft.photo = null; renderExpenseSheet(); } }
    else if (act === 'exp-delete') {
      const d = state.expDraft;
      if (!d || !confirm('Delete this expense?')) return;
      closeSheet();
      state.expenses = state.expenses.filter((x) => x.id !== d.id);
      if (d.photo) dropPhotoUrl(d.photo);
      render();
      try { await Exp.del(d.id); } catch (e) { toast('Could not delete'); }
    }
    else if (act === 'tip') buyTip(el.dataset.id);
    else if (act === 'tip-later') { dismissTipNudge(); render(); }
    else if (act === 'welcome') {
      state.welcomed = true;
      safeSet('odo.welcomed', '1');
      if (isNative) {
        el.disabled = true;
        const ok = await toggleAuto(true);
        if (!ok) { state.tab = 'settings'; toast('Finish the setup steps to record drives automatically', 4500); }
      }
      render();
      window.scrollTo(0, 0);
    }
    else if (act === 'dash') {
      try { state.status = await Tracker.setDash({ enabled: el.dataset.v === '1' }); } catch (e) { toast('Could not change the shift'); }
      render();
      if (state.status.dashing) toast(`Shift started. Drives are logged as ${workLabel()}.`);
    }
    else if (act === 'del-gig') {
      state.prefs.gigs.splice(Number(el.dataset.i), 1);
      render();
      savePrefs();
    }
  });

  document.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('.trip[data-act=open-exp]')) {
      ev.preventDefault();
      openExpense(ev.target.dataset.id);
    }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('.trip[data-act=open]')) {
      ev.preventDefault();
      openTrip(ev.target.dataset.id);
    }
    if (ev.key === 'Escape' && !$('sheet').hidden) closeSheet();
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'receiptFile') { const f = t.files && t.files[0]; t.value = ''; onReceiptPicked(f); return; }
    if (t.id === 'expCat') { syncDraft(); renderExpenseSheet(); return; }
    if (t.id === 'autoToggle') toggleAuto(t.checked);
    else if (t.id === 'rateInput') {
      const c = parseFloat(t.value);
      if (c >= 0) { state.rate = c / 100; safeSet(RATE_KEY, String(state.rate)); toast('Rate saved'); }
    } else if (t.id === 'promptInput') {
      const v = t.value.trim();
      if (v) { state.prefs.prompt = v; savePrefs(); toast('Saved'); }
    } else if (t.id === 'purposeSel') {
      if (t.value === '__other') { state.otherPurpose = true; renderSheet(); const i = $('purposeText'); if (i) i.focus(); }
      else { state.otherPurpose = false; setTrip(state.openTripId, { purpose: t.value }); }
    } else if (t.id === 'purposeText') {
      const v = t.value.trim();
      if (v) setTrip(state.openTripId, { purpose: v });
    }
  });

  document.addEventListener('submit', (ev) => {
    if (ev.target.id === 'expForm') { ev.preventDefault(); saveExpense(); return; }
    if (ev.target.id !== 'gigForm') return;
    ev.preventDefault();
    const v = $('gigInput').value.trim();
    if (!v) return;
    if (state.prefs.gigs.some((g) => g.toLowerCase() === v.toLowerCase())) { toast('Already added'); return; }
    if (state.prefs.gigs.length >= 6) { toast('Up to 6 work types'); return; }
    state.prefs.gigs.push(v);
    render();
    savePrefs();
  });

  $('fab').addEventListener('click', onFab);
  $('sheetBack').addEventListener('click', closeSheet);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { loadStatus().then(() => state.tab === 'settings' && render()); loadTrips(); }
  });

  // ---------- start ----------

  (async function init() {
    try {
      Tracker.addListener('tripsChanged', () => loadTrips());
      Tracker.addListener('trackingChanged', (s) => {
        const permsChanged = ['location', 'background', 'precise', 'activity', 'notifications', 'auto', 'dashing']
          .some((k) => state.status[k] !== s[k]);
        state.status = s;
        // Refresh the setup checklist when a permission answer comes in, unless someone is typing.
        const typing = document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName);
        if (permsChanged && !typing && $('sheet').hidden) render(); else renderChrome();
      });
    } catch (e) { /* listeners are a bonus; polling covers it */ }
    await loadPrefs();
    await loadStatus();
    await loadTrips();
    loadExpenses();
    loadTips();
    startPolling();
  })();

  // ---------- browser preview (sample data) ----------

  function makeMock() {
    const listeners = {};
    const emit = (ev, data) => (listeners[ev] || []).forEach((fn) => fn(data));
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

    function samplePath(lat, lng, miles) {
      const pts = [[lat, lng]];
      let heading = rnd() * Math.PI * 2;
      const steps = Math.max(6, Math.round(miles * 6));
      const stepDeg = (miles * 1.609 / steps) / 111;
      for (let i = 0; i < steps; i++) {
        if (rnd() < 0.3) heading += (rnd() < 0.5 ? 1 : -1) * Math.PI / 2;
        lat += Math.cos(heading) * stepDeg;
        lng += Math.sin(heading) * stepDeg / Math.cos(lat * Math.PI / 180);
        pts.push([+lat.toFixed(5), +lng.toFixed(5)]);
      }
      return pts;
    }

    function sampleTrips() {
      const out = [];
      const today = startOfDay(Date.now()).getTime();
      for (let d = 34; d >= 0; d--) {
        const n = rnd() < 0.25 ? 0 : 1 + Math.floor(rnd() * 4);
        let t = today - d * 86400000 + (16 + rnd() * 2) * 3600000;
        for (let i = 0; i < n; i++) {
          const miles = Math.round((1 + rnd() * 8) * 100) / 100;
          const dur = (miles * 2.4 + rnd() * 6) * 60000;
          if (t + dur > Date.now()) break;
          const type = rnd() < 0.85 ? 'work' : 'personal';
          out.push({
            id: 'm' + d + '-' + i, start: t, end: t + dur, miles, type,
            purpose: type === 'work' ? (rnd() < 0.7 ? 'DoorDash' : 'Uber Eats') : '',
            manual: false, path: samplePath(41.88 + rnd() * 0.05, -87.65 + rnd() * 0.05, miles),
          });
          t += dur + (8 + rnd() * 25) * 60000;
        }
      }
      // The two most recent drives haven't been answered yet.
      out.slice(-2).forEach((t) => { t.type = 'pending'; t.purpose = ''; });
      return out;
    }

    let trips = /[?&]new\b/.test(location.search) ? [] : sampleTrips();
    const prefs = { gigs: [], prompt: 'Was this drive for work?' };
    const status = { location: true, background: false, activity: false, notifications: true,
      batteryUnrestricted: false, auto: false, tracking: false, manual: false, miles: 0, tripStart: 0, sdk: 34 };
    // Preview the iPhone screens with index.html?ios
    if (/[?&]ios\b/.test(location.search)) {
      Object.assign(status, { platform: 'ios', precise: false, batteryUnrestricted: true,
        dashSupported: true, dashing: false, dashSince: 0 });
    }
    let timer = null;
    let tipCount = 0;
    const snap = () => Object.assign({}, status);

    return {
      async getStatus() { return snap(); },
      async requestPerm({ alias }) { status[alias] = true; return snap(); },
      async openAppSettings() {},
      async openBatterySettings() { status.batteryUnrestricted = true; },
      async setAuto({ enabled }) { status.auto = enabled; return snap(); },
      async setDash({ enabled }) { status.dashing = enabled; status.dashSince = enabled ? Date.now() : 0; return snap(); },
      async startManual() {
        Object.assign(status, { tracking: true, manual: true, miles: 0, tripStart: Date.now() });
        timer = setInterval(() => { status.miles += 0.05; emit('trackingChanged', snap()); }, 1000);
        return snap();
      },
      async stopTrip() {
        clearInterval(timer);
        const miles = Math.max(0.1, Math.round(status.miles * 100) / 100);
        trips.push({ id: 'm' + Date.now(), start: status.tripStart, end: Date.now(), miles, type: 'pending',
          purpose: '', manual: true, path: samplePath(41.9, -87.63, miles) });
        Object.assign(status, { tracking: false, manual: false, miles: 0 });
        emit('trackingChanged', snap());
        emit('tripsChanged', {});
      },
      async getTrips() { return { trips: trips.slice() }; },
      async updateTrip({ id, type, purpose }) {
        const t = trips.find((x) => x.id === id);
        if (t) { if (type != null) t.type = type; if (purpose != null) t.purpose = purpose; }
        return { ok: !!t };
      },
      async deleteTrip({ id }) { trips = trips.filter((x) => x.id !== id); return { ok: true }; },
      async getPrefs() { return { gigs: prefs.gigs.slice(), prompt: prefs.prompt }; },
      async getTips() {
        return { count: tipCount, tips: [
          { id: 'com.odomiles.app.tip.small', price: '$0.99', name: 'Small tip' },
          { id: 'com.odomiles.app.tip.medium', price: '$1.99', name: 'Kind tip' },
          { id: 'com.odomiles.app.tip.large', price: '$4.99', name: 'Big tip' }] };
      },
      async buyTip() { tipCount++; return { result: 'thanked', count: tipCount }; },
      async setPrefs(p) { if (p.gigs) prefs.gigs = p.gigs.slice(); if (p.prompt) prefs.prompt = p.prompt; },
      addListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return Promise.resolve({ remove() {} }); },
    };
  }
})();
