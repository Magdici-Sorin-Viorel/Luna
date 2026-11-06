/*
 * Local persistence for Luna.
 * All data stays on the device (localStorage). Nothing is ever sent to a server.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'luna.v1'; // key kept across versions; the payload carries `version`

  const DEFAULTS = {
    version: 3,
    profile: { name: '' },
    settings: { cycleLength: 28, periodLength: 5 },
    periods: [],             // [{ start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' | null }], end is optional
    calendarSyncedFor: null, // predicted start date included in the last calendar export
  };

  // In-memory fallback for browsers where storage is blocked (private mode, etc.)
  let memoryCopy = null;

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function isISODate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  /** Older backups stored every period day; turn consecutive days into periods. */
  function periodsFromDays(days, ongoing) {
    const sorted = [...new Set(days.filter(isISODate))].sort();
    const periods = [];
    const next = (iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      const date = new Date(y, m - 1, d + 1);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };
    for (const day of sorted) {
      const last = periods[periods.length - 1];
      if (last && next(last.end) === day) last.end = day;
      else periods.push({ start: day, end: day });
    }
    // A period that was still running has no confirmed end.
    if (ongoing && periods.length) periods[periods.length - 1].end = null;
    return periods;
  }

  /** Keeps one period per start date, sorted, with valid optional ends. */
  function cleanPeriods(list) {
    const byStart = new Map();
    list.forEach((p) => {
      if (!p || !isISODate(p.start)) return;
      const end = isISODate(p.end) && p.end >= p.start ? p.end : null;
      byStart.set(p.start, { start: p.start, end });
    });
    return [...byStart.values()].sort((a, b) => (a.start < b.start ? -1 : 1));
  }

  /** Coerces any loaded/imported object (v1, v2 or v3) into a valid data shape. */
  function normalize(raw) {
    const data = clone(DEFAULTS);
    if (!raw || typeof raw !== 'object') return data;

    const profile = raw.profile || {};
    data.profile.name = typeof profile.name === 'string' ? profile.name.trim().slice(0, 40) : '';

    const settings = raw.settings || {};
    data.settings.cycleLength = clampInt(settings.cycleLength, 15, 60, 28);
    data.settings.periodLength = clampInt(settings.periodLength, 1, 10, 5);

    if (Array.isArray(raw.periods)) {
      data.periods = cleanPeriods(raw.periods);
    } else if (Array.isArray(raw.days)) {
      data.periods = periodsFromDays(raw.days, Boolean(raw.ongoing));
    }
    data.calendarSyncedFor = isISODate(raw.calendarSyncedFor) ? raw.calendarSyncedFor : null;
    return data;
  }

  function load() {
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (text) return normalize(JSON.parse(text));
    } catch (err) {
      // Storage unavailable or corrupted: fall through to memory/defaults.
    }
    return memoryCopy ? clone(memoryCopy) : clone(DEFAULTS);
  }

  /** Returns true when the data was written to persistent storage. */
  function save(data) {
    memoryCopy = clone(data);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (err) {
      return false;
    }
  }

  function clear() {
    memoryCopy = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      // Nothing to clear.
    }
  }

  function exportJSON(data) {
    const payload = Object.assign({ app: 'luna', exportedAt: new Date().toISOString() }, data);
    return JSON.stringify(payload, null, 2);
  }

  /** Parses a backup file. Throws when the content is not a Luna backup. */
  function importJSON(text) {
    const raw = JSON.parse(text);
    if (!raw || !(Array.isArray(raw.periods) || Array.isArray(raw.days))) throw new Error('Invalid backup');
    return normalize(raw);
  }

  window.LunaStorage = { load, save, clear, exportJSON, importJSON, DEFAULTS };
})();
