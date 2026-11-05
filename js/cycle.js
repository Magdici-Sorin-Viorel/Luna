/*
 * Cycle logic: date helpers, grouping of marked days into periods,
 * robust statistics, current status and predictions with a confidence window.
 * Pure functions, no DOM access.
 *
 * Prediction model
 * ----------------
 * 1. Cycle lengths = gaps between consecutive period start dates.
 * 2. Outliers are rejected with a median/MAD test (robust to one odd month),
 *    but only once there are enough cycles to tell an outlier from normal variation.
 * 3. The expected length is an exponentially weighted mean of the remaining
 *    recent cycles: the latest cycle weighs most, so the model adapts to
 *    gradual changes without overreacting to a single month.
 * 4. The window around the predicted date grows with the standard deviation
 *    of the accepted cycles and shrinks as more cycles are recorded.
 */
(function () {
  'use strict';

  const MERGE_GAP = 1;      // only consecutive marked days belong to the same period
  const MIN_CYCLE = 15;     // cycles outside this range are ignored as data errors
  const MAX_CYCLE = 60;
  const HISTORY_SIZE = 12;  // how many recent cycles feed the model
  const DECAY = 0.8;        // weight multiplier per cycle of age (1, 0.8, 0.64, ...)
  const PREP_DAYS = 3;      // preparation window before a predicted period
  const MAX_ONGOING = 10;   // an open period stops auto-extending after this many days
  const DEFAULT_WINDOW = 4; // +/- days when nothing is known yet

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

  /** Inclusive list of ISO dates from a to b. */
  function range(a, b) {
    const out = [];
    for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
    return out;
  }

  /* ---------- Statistics ---------- */

  function mean(values) {
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function stdDev(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  /** Drops values far from the median (MAD test). Needs 4+ values to be meaningful. */
  function rejectOutliers(values) {
    if (values.length < 4) return { kept: values, dropped: [] };
    const med = median(values);
    const mad = median(values.map((v) => Math.abs(v - med))) * 1.4826; // scaled to ~sd
    const limit = Math.max(4, 2.5 * mad);
    const kept = [];
    const dropped = [];
    values.forEach((v) => (Math.abs(v - med) > limit ? dropped : kept).push(v));
    return kept.length >= 2 ? { kept, dropped } : { kept: values, dropped: [] };
  }

  /** Exponentially weighted mean; the last value weighs most. */
  function weightedMean(values) {
    let sum = 0;
    let weights = 0;
    const n = values.length;
    values.forEach((v, i) => {
      const w = DECAY ** (n - 1 - i);
      sum += v * w;
      weights += w;
    });
    return sum / weights;
  }

  /* ---------- Periods ---------- */

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

  /* ---------- Analysis ---------- */

  /**
   * Learns the user's rhythm from history, falling back to settings.
   * Returns averages, the prediction window and a confidence level.
   */
  function analyze(data) {
    const periods = groupPeriods(data.days);

    // Cycle lengths between consecutive starts, oldest first.
    const allCycles = [];
    for (let i = 1; i < periods.length; i++) {
      const length = daysBetween(periods[i - 1].start, periods[i].start);
      if (length >= MIN_CYCLE && length <= MAX_CYCLE) allCycles.push(length);
    }
    const recent = allCycles.slice(-HISTORY_SIZE);
    const { kept, dropped } = rejectOutliers(recent);

    const learned = kept.length >= 1;
    const avgCycle = learned ? Math.round(weightedMean(kept)) : data.settings.cycleLength;
    const sd = stdDev(kept);

    // Window: 1.5 sd, at least 1 day, never more than 7; wider while data is scarce.
    let window;
    if (kept.length === 0) window = DEFAULT_WINDOW;
    else if (kept.length === 1) window = 3;
    else if (kept.length === 2) window = Math.max(2, Math.round(1.5 * sd));
    else window = Math.max(1, Math.round(1.5 * sd));
    window = Math.min(7, window);

    let confidence;
    if (kept.length >= 6 && sd <= 2) confidence = 'high';
    else if (kept.length >= 3 && sd <= 4) confidence = 'medium';
    else confidence = 'low';

    // Period length: an ongoing period is not finished, so it does not count.
    const closed = data.ongoing ? periods.slice(0, -1) : periods;
    const periodLengths = closed.slice(-HISTORY_SIZE).map((p) => p.length);
    const avgPeriod = periodLengths.length
      ? Math.max(1, Math.round(weightedMean(periodLengths)))
      : data.settings.periodLength;

    return {
      periods,
      cycles: allCycles,
      cycleCount: kept.length,
      droppedCount: dropped.length,
      droppedValues: dropped,
      learned,
      avgCycle,
      avgPeriod,
      sd,
      window,
      confidence,
      shortest: kept.length ? Math.min(...kept) : null,
      longest: kept.length ? Math.max(...kept) : null,
    };
  }

  /**
   * Current situation. kind is one of:
   * 'empty' | 'period' | 'prep' | 'due' | 'late' | 'normal'
   */
  function status(data, analysis, todayISO) {
    const last = analysis.periods[analysis.periods.length - 1];
    if (!last) return { kind: 'empty' };

    const cycleDay = daysBetween(last.start, todayISO) + 1;
    const nextStart = addDays(last.start, analysis.avgCycle);
    const windowStart = addDays(nextStart, -analysis.window);
    const windowEnd = addDays(nextStart, analysis.window);
    const daysUntil = daysBetween(todayISO, nextStart);
    const base = { cycleDay, nextStart, windowStart, windowEnd, daysUntil, last };

    const insideLast = todayISO >= last.start && todayISO <= last.end;
    if (insideLast || data.ongoing) {
      return Object.assign(base, { kind: 'period', periodDay: cycleDay });
    }
    if (todayISO > windowEnd) {
      return Object.assign(base, { kind: 'late', lateBy: daysBetween(windowEnd, todayISO) });
    }
    if (todayISO >= windowStart) return Object.assign(base, { kind: 'due' });
    if (daysBetween(todayISO, windowStart) <= PREP_DAYS) return Object.assign(base, { kind: 'prep' });
    return Object.assign(base, { kind: 'normal' });
  }

  /** Upcoming predicted periods with their windows and preparation days. */
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
        windowStart: addDays(start, -analysis.window),
        windowEnd: addDays(start, analysis.window),
        prepStart: addDays(start, -analysis.window - PREP_DAYS),
      });
      start = addDays(start, analysis.avgCycle);
    }
    return list;
  }

  window.LunaCycle = {
    PREP_DAYS, MAX_CYCLE,
    toISO, fromISO, addDays, daysBetween, today, range,
    groupPeriods, syncOngoing, analyze, status, predictions,
  };
})();
