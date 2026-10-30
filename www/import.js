/* Odo - reads past trips from a spreadsheet saved as CSV. Loaded before app.js. */
(function () {
  'use strict';

  /** Splits CSV text into rows of cells. Handles quotes, commas inside quotes, and ; or tab separators. */
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const counts = { ',': (firstLine.match(/,/g) || []).length, ';': (firstLine.match(/;/g) || []).length, '\t': (firstLine.match(/\t/g) || []).length };
    const sep = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ',';
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
  }

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  /** Returns local midnight (ms) for the date in a cell, or null. */
  function parseDate(s) {
    if (!s) return null;
    s = s.trim();
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return mk(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
      let y = +m[3];
      if (y < 100) y += 2000;
      return mk(y, +m[1] - 1, +m[2]); // US month/day/year
    }
    if ((m = s.match(/^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/))) {
      const mo = MONTHS[m[1].toLowerCase()];
      if (mo != null) return mk(+m[3], mo, +m[2]);
    }
    if (/^\d{5}(\.\d+)?$/.test(s)) { // Excel serial date
      const d = new Date(Math.round((parseFloat(s) - 25569) * 86400000));
      return mk(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
    return null;
  }

  function mk(y, mo, d) {
    const dt = new Date(y, mo, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
    return dt.getTime();
  }

  /** Minutes after midnight for a time cell like "4:33 PM", "16:33" or "0.69" (Excel fraction). */
  function parseTime(s) {
    if (!s) return null;
    let m = s.trim().match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
    if (m) {
      let h = +m[1];
      const ap = m[3] && m[3].toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      return h < 24 && +m[2] < 60 ? h * 60 + +m[2] : null;
    }
    if (/^0?\.\d+$/.test(s.trim())) return Math.round(parseFloat(s) * 1440);
    return null;
  }

  function num(s) {
    if (s == null) return NaN;
    const t = String(s).replace(/[,$\s]/g, '').replace(/mi(les)?$/i, '');
    return t === '' ? NaN : parseFloat(t);
  }

  function findCol(header, tests) {
    for (const test of tests) {
      const i = header.findIndex((h) => test.test(h));
      if (i >= 0) return i;
    }
    return -1;
  }

  /** Small stable hash, so importing the same file twice doesn't create duplicates. */
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  /**
   * Turns CSV text into Odo trips.
   * Returns { trips, skipped, columns, error }.
   */
  function toTrips(text, opts) {
    const workLabel = (opts && opts.workLabel) || 'Work';
    const rows = parseCsv(text);
    if (!rows.length) return { trips: [], skipped: 0, error: 'That file is empty.' };

    const head = rows[0].map((h) => h.toLowerCase());
    const hasHeader = head.some((h) => /date|mile|distance|odometer|purpose/.test(h));
    let cDate = -1, cMiles = -1, cStart = -1, cEnd = -1, cTime = -1, cPurpose = -1, cType = -1;
    if (hasHeader) {
      cDate = findCol(head, [/^date$/, /date/, /^day$/]);
      cMiles = findCol(head, [/business\s*mi/, /^miles?$/, /mile/, /distance/, /^mi$/]);
      cStart = findCol(head, [/(start|begin).*odo/, /odo.*(start|begin)/, /^start(ing)?\s*(reading|mileage)?$/, /begin/]);
      cEnd = findCol(head, [/end.*odo/, /odo.*end/, /^end(ing)?\s*(reading|mileage)?$/]);
      cTime = findCol(head, [/start\s*time/, /^time$/, /time/]);
      cPurpose = findCol(head, [/purpose/, /description/, /reason/, /platform|^app$|client|company|gig|service/, /note/]);
      cType = findCol(head, [/^type$/, /category/, /business\s*\/?\s*personal/, /work\s*\/?\s*personal/]);
      if (cTime === cStart || cTime === cEnd) cTime = -1;
    } else {
      cDate = rows[0].findIndex((c) => parseDate(c) != null);
      cMiles = rows[0].findIndex((c, i) => i !== cDate && !isNaN(num(c)));
    }
    if (cDate < 0) return { trips: [], skipped: rows.length, error: 'Couldn’t find a date column. Name one column “Date.”' };
    if (cMiles < 0 && (cStart < 0 || cEnd < 0)) {
      return { trips: [], skipped: rows.length, error: 'Couldn’t find a miles column. Name one column “Miles.”' };
    }

    const trips = [];
    let skipped = 0;
    const seen = new Map();
    for (const r of rows.slice(hasHeader ? 1 : 0)) {
      const day = parseDate(r[cDate]);
      let miles = cMiles >= 0 ? num(r[cMiles]) : NaN;
      if (isNaN(miles) && cStart >= 0 && cEnd >= 0) miles = num(r[cEnd]) - num(r[cStart]);
      if (day == null || !(miles > 0) || miles > 2000) { skipped++; continue; }
      const typeText = ((cType >= 0 ? r[cType] : '') + ' ' + (cPurpose >= 0 ? r[cPurpose] : '')).toLowerCase();
      // "Personal" in the type or purpose column, or a cell that says only "Personal", marks a personal trip.
      const personal = /\bpersonal\b/.test(typeText) || r.some((c) => /^personal$/i.test(c));
      let purpose = cPurpose >= 0 ? (r[cPurpose] || '').slice(0, 40) : '';
      if (personal) purpose = '';
      else if (!purpose || /^(business|work)$/i.test(purpose)) purpose = workLabel;
      const mins = cTime >= 0 ? parseTime(r[cTime]) : null;
      const start = day + (mins == null ? 12 * 60 : mins) * 60000;
      miles = Math.round(miles * 100) / 100;
      const key = `${day}|${miles}|${purpose}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      trips.push({
        id: 'imp-' + hash(key + '|' + n), start, end: start, miles,
        type: personal ? 'personal' : 'work', purpose, manual: true, path: [], added: true,
      });
    }
    return { trips, skipped, error: trips.length ? null : 'No trips found. Each row needs a date and miles.' };
  }

  window.OdoImport = { toTrips, parseCsv, parseDate };
})();
