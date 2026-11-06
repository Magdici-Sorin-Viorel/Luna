/*
 * Cycle logic: date helpers, period resolution, robust statistics,
 * current status and predictions with a confidence window.
 * Pure functions, no DOM access.
 *
 * Data model
 * ----------
 * The user records the FIRST day of each period. The last day is optional:
 * when it is missing, the period is assumed to last the user's typical
 * duration (learned from the periods whose end was recorded, otherwise the
 * value from Settings). Everything that matters for prediction comes from
 * first days only.
 *
 * Prediction model
 * ----------------
 * 1. The next first day = last first day + the cycle length. That length is the
 *    value from Settings (28 by default) until at least three consistent cycles
 *    are recorded; only then is it replaced by the learned rhythm. Entries are
 *    often sparse, so a gap close to 2× or 3× the length is read as that many
 *    cycles, and a gap that matches no multiple is ignored as unreliable.
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

  const MIN_CYCLE = 15;     // cycles outside this range are ignored as data errors
  const MAX_CYCLE = 60;
  const MAX_PERIOD = 15;    // a recorded period longer than this is treated as an input error
  const HISTORY_SIZE = 12;  // how many recent cycles feed the model
  const DECAY = 0.8;        // weight multiplier per cycle of age (1, 0.8, 0.64, ...)
  const PREP_DAYS = 3;      // preparation window before a predicted period
  const DEFAULT_WINDOW = 4; // +/- days when nothing is known yet
  const GAP_TOLERANCE = 10;     // days a gap may differ from k × reference and still count as k cycles
  const MIN_TRUSTED_CYCLES = 3; // the learned rhythm replaces the Settings value only from here on
  const MAX_TRUSTED_SD = 4;     // ...and only while the cycles are reasonably consistent

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

  /** Typical period length: learned from recorded last days, else the setting. */
  function typicalPeriodLength(data) {
    const known = data.periods
      .filter((p) => p.end)
      .map((p) => daysBetween(p.start, p.end) + 1)
      .filter((n) => n >= 1 && n <= MAX_PERIOD)
      .slice(-HISTORY_SIZE);
    return known.length ? Math.max(1, Math.round(weightedMean(known))) : data.settings.periodLength;
  }

  /**
   * Periods with their end resolved: recorded, or assumed from the typical length
   * (never running into the next period). Sorted by start, oldest first.
   * Each item: { start, end, length, endKnown }.
   */
  function resolvePeriods(data, typicalLength) {
    const sorted = [...data.periods].sort((a, b) => (a.start < b.start ? -1 : 1));
    return sorted.map((p, i) => {
      const next = sorted[i + 1];
      let end = p.end;
      if (!end) {
        end = addDays(p.start, typicalLength - 1);
        if (next && end >= next.start) end = addDays(next.start, -1);
      }
      return { start: p.start, end, length: daysBetween(p.start, end) + 1, endKnown: Boolean(p.end) };
    });
  }

  /* ---------- Analysis ---------- */

  /**
   * Learns the user's rhythm from first days, falling back to settings.
   * Returns resolved periods, averages, the prediction window and a confidence level.
   */
  function analyze(data) {
    const avgPeriod = typicalPeriodLength(data);
    const periods = resolvePeriods(data, avgPeriod);

    // Gaps between consecutive first days, oldest first.
    const gaps = [];
    for (let i = 1; i < periods.length; i++) gaps.push(daysBetween(periods[i - 1].start, periods[i].start));

    /**
     * Reads the gaps against a reference length. Entries are often sparse
     * ("I forgot that month"), so a gap close to k × reference is read as k cycles,
     * and a gap that matches no multiple is ignored as unreliable.
     */
    const readGaps = (reference) => {
      const cycles = [];
      gaps.forEach((g) => {
        let best = null;
        for (let k = 1; k <= 3; k++) {
          const each = g / k;
          const diff = Math.abs(each - reference);
          if (diff <= GAP_TOLERANCE && (!best || diff < best.diff)) best = { length: Math.round(each), span: k, diff };
        }
        if (best) cycles.push({ length: best.length, span: best.span });
      });
      return cycles;
    };

    /** The learned length, or null while the data is too scarce or too irregular to trust. */
    const learnFrom = (cycles) => {
      const recent = cycles.slice(-HISTORY_SIZE).map((c) => c.length);
      const { kept, dropped } = rejectOutliers(recent);
      const sd = stdDev(kept);
      const trusted = kept.length >= MIN_TRUSTED_CYCLES && sd <= MAX_TRUSTED_SD;
      return { kept, dropped, sd, learned: trusted ? Math.round(weightedMean(kept)) : null };
    };

    // Pass 1 against the Settings value; pass 2 against the learned rhythm, if any,
    // so that someone with 35-day cycles is not read as skipping months.
    let cycles = readGaps(data.settings.cycleLength);
    let fit = learnFrom(cycles);
    if (fit.learned !== null && fit.learned !== data.settings.cycleLength) {
      cycles = readGaps(fit.learned);
      fit = learnFrom(cycles);
    }
    const { kept, dropped, sd } = fit;
    const allCycles = cycles;
    const learned = fit.learned !== null;
    const avgCycle = learned ? fit.learned : data.settings.cycleLength;

    // Window: 1.5 sd, at least 1 day, never more than 7; wider while data is scarce.
    let window;
    if (!learned) window = Math.max(DEFAULT_WINDOW, Math.min(7, Math.round(1.5 * sd)));
    else window = Math.min(7, Math.max(1, Math.round(1.5 * sd)));

    let confidence;
    if (learned && kept.length >= 6 && sd <= 2) confidence = 'high';
    else if (learned) confidence = 'medium';
    else confidence = 'low';

    return {
      periods,
      cycles: allCycles.map((c) => c.length),
      splitGaps: allCycles.filter((c) => c.span > 1).length,
      ignoredGaps: gaps.length - allCycles.length,
      cycleCount: kept.length,
      droppedCount: dropped.length,
      droppedValues: dropped,
      learned,
      avgCycle,
      avgPeriod,
      periodLearned: data.periods.some((p) => p.end),
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
  function status(analysis, todayISO) {
    const last = analysis.periods[analysis.periods.length - 1];
    if (!last) return { kind: 'empty' };

    const cycleDay = daysBetween(last.start, todayISO) + 1;
    const nextStart = addDays(last.start, analysis.avgCycle);
    const windowStart = addDays(nextStart, -analysis.window);
    const windowEnd = addDays(nextStart, analysis.window);
    const daysUntil = daysBetween(todayISO, nextStart);
    const base = { cycleDay, nextStart, windowStart, windowEnd, daysUntil, last };

    if (todayISO >= last.start && todayISO <= last.end) {
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
    PREP_DAYS, MAX_CYCLE, MAX_PERIOD,
    toISO, fromISO, addDays, daysBetween, today, range,
    analyze, status, predictions,
  };
})();
