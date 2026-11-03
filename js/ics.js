/*
 * Calendar export (.ics). The phone's calendar app shows the reminders,
 * so Luna gets real notifications without any server.
 */
(function () {
  'use strict';

  const ALARM_HOUR = 9; // reminder at 09:00 on the event day

  function compact(iso) {
    return iso.replace(/-/g, '');
  }

  function escapeText(text) {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\n/g, '\\n');
  }

  function utcStamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  /** One all-day event (end date is exclusive in iCalendar). */
  function event(uid, startISO, endInclusiveISO, summary, description, addDays) {
    return [
      'BEGIN:VEVENT',
      `UID:${uid}@luna.app`,
      `DTSTAMP:${utcStamp()}`,
      `DTSTART;VALUE=DATE:${compact(startISO)}`,
      `DTEND;VALUE=DATE:${compact(addDays(endInclusiveISO, 1))}`,
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${escapeText(description)}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(summary)}`,
      `TRIGGER:PT${ALARM_HOUR}H`,
      'END:VALARM',
      'END:VEVENT',
    ];
  }

  /**
   * Builds the calendar file for upcoming predictions.
   * UIDs are stable per slot, so re-exporting updates events instead of duplicating them
   * (in calendar apps that support updates).
   */
  function build(predictions, addDays) {
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Luna//Cycle calendar//RO',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Luna',
    ];
    predictions.forEach((p, i) => {
      lines.push(...event(
        `prep-${i + 1}`,
        p.prepStart,
        p.prepStart,
        'Luna: pregătire, ciclul vine în ~3 zile',
        'Verifică absorbantele, pune o rezervă în geantă și un analgezic, odihnește-te mai mult.',
        addDays
      ));
      lines.push(...event(
        `period-${i + 1}`,
        p.start,
        p.end,
        'Luna: ciclu estimat',
        'Estimare orientativă. Marchează în Luna ziua în care începe.',
        addDays
      ));
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  window.LunaICS = { build };
})();
