/*
 * Cycle logic: date helpers, grouping of marked days into periods,
 * averages, current status and predictions. Pure functions, no DOM access.
 */
(function () {
  'use strict';

  const MERGE_GAP = 2;     // marked days up to 2 days apart belong to the same period
  const MIN_CYCLE = 15;    // cycles outside this range are ignored as data errors
  const MAX_CYCLE = 60;
  const HISTORY_SIZE = 6;  // how many recent cycles feed the average
  const PREP_DAYS = 3;     // preparation window before a predicted period
  const MAX_ONGOING = 10;  // an open period stops auto-extending after this many days

  /* ---------- Date helpers (local dates, ISO strings) ---------- */

  function toISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function fromISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(iso, n) {
    const date = fromISO(iso);
    date.setDate(date.getDate() + n);
    return toISO(date);
  }

  /** Number of days from a to b (positive when b is later). DST-safe. */
  function daysBetween(a, b) {
    const da = fromISO(a);
    const db = fromISO(b);
    const utcA = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
    const utcB = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
    return Math.round((utcB - utcA) / 86400000);
  }

  function today() {
    return toISO(new Date());
  }

  function mean(values) {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /* ---------- Periods and statistics ---------- */

  /** Groups marked days into periods: [{ start, end, length }]. */
  function groupPeriods(days) {
    const sorted = [...new Set(days)].sort();
    const periods = [];
    for (const day of sorted) {
      const last = periods[periods.length - 1];
      if (last && daysBetween(last.end, day) <= MERGE_GAP) {
        last.end = day;
      } else {
        periods.push({ start: day, end: day });
      }
    }
    periods.forEach((p) => { p.length = daysBetween(p.start, p.end) + 1; });
    return periods;
  }

  /**
   * While a period is marked as ongoing, fill in every day up to today.
   * Mutates data; returns true when something changed.
   */
  function syncOngoing(data, todayISO) {
    if (!data.ongoing) return false;
    const periods = groupPeriods(data.days);
    const last = periods[periods.length - 1];
    if (!last) {
      data.ongoing = false;
      return true;
    }
    const span = daysBetween(last.start, todayISO) + 1;
    if (span < 1 || span > MAX_ONGOING) {
      data.ongoing = false;
      return true;
    }
    let changed = false;
    let day = last.end;
    while (daysBetween(day, todayISO) > 0) {
      day = addDays(day, 1);
      data.days.push(day);
      changed = true;
    }
    if (changed) data.days.sort();
    return changed;
  }

  /** Averages learned from history, falling back to the user's settings. */
  function analyze(data) {
    const periods = groupPeriods(data.days);

    const cycles = [];
    for (let i = 1; i < periods.length; i++) {
      const length = daysBetween(periods[i - 1].start, periods[i].start);
      if (length >= MIN_CYCLE && length <= MAX_CYCLE) cycles.push(length);
    }
    const recentCycles = cycles.slice(-HISTORY_SIZE);
    const avgCycle = recentCycles.length
      ? Math.round(mean(recentCycles))
      : data.settings.cycleLength;

    // An ongoing period is not finished yet, so it does not count for the average length.
    const closedPeriods = data.ongoing ? periods.slice(0, -1) : periods;
    const recentPeriods = closedPeriods.slice(-HISTORY_SIZE).map((p) => p.length);
    const avgPeriod = recentPeriods.length
      ? Math.max(1, Math.round(mean(recentPeriods)))
      : data.settings.periodLength;

    return {
      periods,
      avgCycle,
      avgPeriod,
      cycleCount: recentCycles.length,
      learned: recentCycles.length >= 1,
    };
  }

  /**
   * Current situation. kind is one of:
   * 'empty' | 'period' | 'prep' | 'late' | 'normal'
   */
  function status(data, analysis, todayISO) {
    const last = analysis.periods[analysis.periods.length - 1];
    if (!last) return { kind: 'empty' };

    const cycleDay = daysBetween(last.start, todayISO) + 1;
    const nextStart = addDays(last.start, analysis.avgCycle);
    const daysUntil = daysBetween(todayISO, nextStart);
    const base = { cycleDay, nextStart, daysUntil, last };

    const insideLast = todayISO >= last.start && todayISO <= last.end;
    if (insideLast || data.ongoing) {
      return Object.assign(base, { kind: 'period', periodDay: cycleDay });
    }
    if (daysUntil < 0) return Object.assign(base, { kind: 'late', lateBy: -daysUntil });
    if (daysUntil <= PREP_DAYS) return Object.assign(base, { kind: 'prep' });
    return Object.assign(base, { kind: 'normal' });
  }

  /** Upcoming predicted periods with their preparation windows. */
  function predictions(analysis, currentStatus, todayISO, count) {
    if (!analysis.periods.length) return [];
    const last = analysis.periods[analysis.periods.length - 1];
    // When late, assume the period can start any day now.
    let start = currentStatus.kind === 'late'
      ? addDays(todayISO, 1)
      : addDays(last.start, analysis.avgCycle);

    const list = [];
    for (let i = 0; i < count; i++) {
      list.push({
        start,
        end: addDays(start, analysis.avgPeriod - 1),
        prepStart: addDays(start, -PREP_DAYS),
      });
      start = addDays(start, analysis.avgCycle);
    }
    return list;
  }

  window.LunaCycle = {
    PREP_DAYS,
    toISO, fromISO, addDays, daysBetween, today,
    groupPeriods, syncOngoing, analyze, status, predictions,
  };
})();
