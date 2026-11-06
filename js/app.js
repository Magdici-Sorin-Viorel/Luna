/*
 * Luna — UI layer. Renders the views and wires up user actions.
 * Interface text is Romanian; code and comments are English.
 */
(function () {
  'use strict';

  const Store = window.LunaStorage;
  const Cycle = window.LunaCycle;
  const ICS = window.LunaICS;
  const QR = window.LunaQR;

  const CALENDAR_EVENTS = 3; // predicted cycles included in the calendar export
  const CYCLES_FOR_GOOD_PREDICTION = 3;

  /* ---------- Romanian text helpers ---------- */

  const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie',
    'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
  const MONTHS_SHORT = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun',
    'iul', 'aug', 'sept', 'oct', 'nov', 'dec'];
  const WEEKDAYS = ['duminică', 'luni', 'marți', 'miercuri', 'joi', 'vineri', 'sâmbătă'];

  /** Preparation tips, keyed by days left until the probable window opens. */
  const TIPS = {
    3: [
      'Verifică dacă ai destule absorbante sau tampoane acasă.',
      'Notează pe lista de cumpărături ce îți lipsește.',
      'Dacă poți, planifică zilele următoare ceva mai lejer.',
    ],
    2: [
      'Pune în geantă un absorbant de rezervă.',
      'Ia cu tine analgezicul pe care îl folosești de obicei.',
      'Bea mai multă apă azi.',
    ],
    1: [
      'Pregătește perna termică sau o sticlă cu apă caldă.',
      'Încearcă să te culci mai devreme în seara asta.',
      'Alege pentru mâine haine comode.',
    ],
    0: [
      'Ține absorbantele la îndemână, plus o rezervă în geantă.',
      'O plimbare ușoară poate ajuta la crampe.',
      'Ascultă-ți corpul și odihnește-te când simți nevoia.',
    ],
  };

  const CONFIDENCE_LABEL = { high: 'Precizie ridicată', medium: 'Precizie medie', low: 'Precizie scăzută' };

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** Romanian plural for days: 1 zi, 5 zile, 21 de zile. */
  function daysText(n) {
    if (n === 1) return '1 zi';
    const rest = n % 100;
    if (n >= 20 && (rest === 0 || rest >= 20)) return `${n} de zile`;
    return `${n} zile`;
  }

  function cyclesText(n) {
    if (n === 1) return 'un ciclu';
    const rest = n % 100;
    if (n >= 20 && (rest === 0 || rest >= 20)) return `${n} de cicluri`;
    return `${n} cicluri`;
  }

  function formatShort(iso, withYear) {
    const d = Cycle.fromISO(iso);
    const year = withYear ? ` ${d.getFullYear()}` : '';
    return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${year}`;
  }

  function formatLong(iso) {
    const d = Cycle.fromISO(iso);
    return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }

  /** "12–16 dec" or "30 nov – 4 dec". */
  function formatRange(a, b) {
    const da = Cycle.fromISO(a);
    const db = Cycle.fromISO(b);
    if (da.getMonth() === db.getMonth()) return `${da.getDate()}–${db.getDate()} ${MONTHS_SHORT[da.getMonth()]}`;
    return `${formatShort(a)} – ${formatShort(b)}`;
  }

  /* ---------- State ---------- */

  let data = Store.load();
  let currentView = 'today';
  let calendarMonth = null; // { year, month }
  let sheetDay = null;      // ISO date open in the calendar sheet
  let pickMode = null;      // 'start' | 'end' while the date picker is open
  let obStep = 1;
  let toastTimer = null;

  const $ = (id) => document.getElementById(id);

  function persist() {
    if (!Store.save(data)) {
      showToast('Datele nu pot fi salvate permanent în acest browser.');
    }
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    toast.classList.remove('is-visible');
    void toast.offsetWidth; // restart the transition
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => { toast.hidden = true; }, 250);
    }, 2800);
  }

  /* ---------- Data edits (all go through here) ---------- */

  /** Records a period by its first day; the last day is optional. Replaces an entry with the same start. */
  function addPeriod(start, end) {
    data.periods = data.periods.filter((p) => p.start !== start);
    data.periods.push({ start, end: end || null });
    data.periods.sort((a, b) => (a.start < b.start ? -1 : 1));
  }

  function removePeriod(start) {
    data.periods = data.periods.filter((p) => p.start !== start);
  }

  /** The recorded period that `day` would belong to: the latest one starting on or before it. */
  function periodBefore(day) {
    return [...data.periods].reverse().find((p) => p.start <= day) || null;
  }

  /** Sets the last day of the period containing `day`. Returns false when there is none. */
  function endPeriodOn(day) {
    const period = periodBefore(day);
    if (!period) return false;
    const next = data.periods.find((p) => p.start > period.start);
    if (next && day >= next.start) return false;
    if (Cycle.daysBetween(period.start, day) + 1 > Cycle.MAX_PERIOD) return false;
    period.end = day;
    return true;
  }

  /* ---------- Rendering ---------- */

  function showView(name) {
    ['onboarding', 'today', 'calendar', 'history', 'settings'].forEach((v) => {
      $(`view-${v}`).hidden = v !== name;
    });
    document.querySelectorAll('.tab').forEach((tab) => {
      const active = tab.dataset.view === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-current', active ? 'page' : 'false');
    });
  }

  function needsOnboarding() {
    return !data.profile.name && data.periods.length === 0;
  }

  function render() {
    const todayISO = Cycle.today();
    if (needsOnboarding()) {
      $('tabbar').hidden = true;
      showView('onboarding');
      renderOnboarding(todayISO);
      return;
    }
    $('tabbar').hidden = false;
    showView(currentView);

    const analysis = Cycle.analyze(data);
    const status = Cycle.status(analysis, todayISO);
    renderToday(analysis, status, todayISO);
    renderCalendar(analysis, status, todayISO);
    renderHistory(analysis, todayISO);
    renderSettings();
  }

  /* ----- Onboarding ----- */

  function renderOnboarding(todayISO) {
    [1, 2, 3].forEach((n) => { $(`ob-step-${n}`).hidden = n !== obStep; });
    document.querySelectorAll('.ob-progress i').forEach((bar, i) => bar.classList.toggle('is-done', i < obStep));
    if (obStep === 2 && !$('obMonths').children.length) renderMonthEditor($('obMonths'), todayISO);
    window.scrollTo(0, 0);
  }

  /* ----- Month editor (shared by onboarding and settings) ----- */

  const EDITOR_MONTHS = 6;

  /** All periods whose first day falls in the given month key (YYYY-MM), oldest first. */
  function periodsInMonth(key) {
    return data.periods.filter((p) => p.start.startsWith(`${key}-`));
  }

  function entryMarkup(monthStart, maxStart, startVal) {
    return `
      <div class="entry">
        <label class="field"><span class="field-label">Prima zi a ciclului</span>
          <input type="date" name="start" min="${monthStart}" max="${maxStart}" value="${startVal}"></label>
        <button type="button" class="entry-remove" data-remove-entry aria-label="Scoate acest ciclu">✕</button>
      </div>`;
  }

  /**
   * Renders the last EDITOR_MONTHS months, newest first, prefilled from recorded periods.
   * A month can hold several periods (a 28-day cycle sometimes starts twice in one month).
   */
  function renderMonthEditor(container, todayISO) {
    const t = Cycle.fromISO(todayISO);
    const rows = [];
    for (let i = 0; i < EDITOR_MONTHS; i++) {
      const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
      const year = d.getFullYear();
      const month = d.getMonth();
      const key = `${year}-${String(month + 1).padStart(2, '0')}`;
      const monthStart = Cycle.toISO(d);
      const monthEnd = Cycle.toISO(new Date(year, month + 1, 0));
      const maxStart = monthEnd < todayISO ? monthEnd : todayISO;
      const periods = periodsInMonth(key);
      const entries = periods.length ? periods : [{ start: '' }];
      const note = periods.length === 0
        ? (i === 0 ? 'luna curentă' : '')
        : periods.length === 1 ? 'un ciclu notat' : `${periods.length} cicluri notate`;
      rows.push(`
        <div class="month-row ${periods.length ? 'is-filled' : ''}" data-month="${key}"
             data-month-start="${monthStart}" data-max-start="${maxStart}">
          <div class="month-row-head"><span>${capitalize(MONTHS[month])} ${year}</span><small>${note}</small></div>
          <div class="entries">${entries.map((p) => entryMarkup(monthStart, maxStart, p.start)).join('')}</div>
          <button type="button" class="btn btn-link entry-add" data-add-entry>+ Încă un ciclu în această lună</button>
        </div>`);
    }
    container.innerHTML = rows.join('');
  }

  /** Adds an empty entry to a month row (max 3 per month). */
  function addMonthEntry(row) {
    const entries = row.querySelector('.entries');
    if (entries.children.length >= 3) { showToast('Maximum 3 cicluri într-o lună.'); return; }
    entries.insertAdjacentHTML('beforeend', entryMarkup(row.dataset.monthStart, row.dataset.maxStart, ''));
    entries.lastElementChild.querySelector('input[name="start"]').focus();
  }

  /**
   * Reads the editor. Returns { changes }: one item per month whose first days differ
   * from what is recorded, as { key, entries: [{ start, end }] }, or { error }.
   * A last day already recorded for an unchanged first day is kept.
   */
  function readMonthEditor(container) {
    const todayISO = Cycle.today();
    const changes = [];
    for (const row of container.querySelectorAll('.month-row')) {
      const key = row.dataset.month;
      const [year, month] = key.split('-').map(Number);
      const label = capitalize(`${MONTHS[month - 1]} ${year}`);
      const recorded = periodsInMonth(key);
      const entries = [];
      for (const entry of row.querySelectorAll('.entry')) {
        const start = entry.querySelector('input[name="start"]').value;
        if (!start) continue;
        if (!start.startsWith(`${key}-`)) return { error: `${label}: prima zi trebuie să fie în această lună.` };
        if (start > todayISO) return { error: `${label}: prima zi nu poate fi în viitor.` };
        if (entries.some((e) => e.start === start)) return { error: `${label}: aceeași primă zi apare de două ori.` };
        const existing = recorded.find((p) => p.start === start);
        entries.push({ start, end: existing ? existing.end : null });
      }
      entries.sort((a, b) => (a.start < b.start ? -1 : 1));
      if (recorded.map((p) => p.start).join(',') !== entries.map((e) => e.start).join(',')) changes.push({ key, entries });
    }
    return { changes };
  }

  /** Applies editor changes: each changed month is replaced by its edited entries. */
  function applyMonthChanges(changes) {
    changes.forEach((c) => {
      periodsInMonth(c.key).forEach((p) => removePeriod(p.start));
      c.entries.forEach((e) => addPeriod(e.start, e.end));
    });
    return changes.length;
  }

  function finishOnboardingData(changes) {
    applyMonthChanges(changes);
    persist();
    const analysis = Cycle.analyze(data);
    const count = analysis.periods.length;
    const name = data.profile.name;
    if (!count) {
      $('obDoneTitle').textContent = `Gata, ${name}`;
      $('obDoneText').textContent = 'Luna pornește de la zero. De la primul ciclu notat începe să învețe ritmul tău.';
    } else {
      const status = Cycle.status(analysis, Cycle.today());
      $('obDoneTitle').textContent = `Mulțumesc, ${name}`;
      $('obDoneText').textContent = count === 1
        ? `Am notat un ciclu. Următorul e estimat în jurul datei de ${formatShort(status.nextStart)}. După al doilea ciclu notat, Luna începe să calculeze ritmul tău.`
        : `Am notat ${cyclesText(count)}. Următorul e estimat în jurul datei de ${formatShort(status.nextStart)}, cu ${CONFIDENCE_LABEL[analysis.confidence].toLowerCase()}.`;
    }
    obStep = 3;
    renderOnboarding(Cycle.today());
  }

  /* ----- Today ----- */

  function timelineMarkup(analysis, status) {
    const total = analysis.avgCycle + analysis.window; // bar spans the whole probable window
    const pct = (days) => `${Math.max(0, Math.min(100, (days / total) * 100))}%`;
    const period = Math.min(analysis.avgPeriod, analysis.avgCycle);
    const windowStart = analysis.avgCycle - analysis.window;
    const prepStart = Math.max(period, windowStart - Cycle.PREP_DAYS);
    const todayPos = Math.min(status.cycleDay - 0.5, total);
    return `
      <i class="tl-seg tl-period" style="left:0;width:${pct(period)}"></i>
      <i class="tl-seg tl-prep" style="left:${pct(prepStart)};width:${pct(windowStart - prepStart)}"></i>
      <i class="tl-seg tl-window" style="left:${pct(windowStart)};width:${pct(total - windowStart)}"></i>
      <i class="tl-today" style="left:${pct(todayPos)}"></i>`;
  }

  function renderToday(analysis, status, todayISO) {
    const name = data.profile.name;
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'Bună dimineața' : hour < 18 ? 'Bună' : 'Bună seara';
    $('greetingHi').textContent = name ? `${hello}, ${name}` : hello;
    $('todayLabel').textContent = capitalize(formatLong(todayISO));

    const hero = $('hero');
    hero.dataset.kind = status.kind;
    const eyebrow = $('heroEyebrow');
    const title = $('heroTitle');
    const detail = $('heroDetail');
    const primary = $('primaryBtn');
    const secondary = $('secondaryBtn');
    let tips = null;

    if (status.kind === 'empty') {
      eyebrow.textContent = 'Primul pas';
      title.textContent = 'Încă nu am niciun ciclu notat';
      detail.textContent = 'Apasă butonul în prima zi a ciclului. Atât e de ajuns: Luna calculează restul.';
      $('timeline').innerHTML = '';
      $('timelineCaption').textContent = '';
      primary.textContent = 'A început ciclul';
      primary.dataset.action = 'start-today';
      secondary.textContent = 'A început în altă zi';
      secondary.dataset.action = 'pick-start';
    } else {
      switch (status.kind) {
        case 'period':
          eyebrow.textContent = 'Menstruație';
          title.textContent = `Ziua ${status.periodDay}`;
          detail.textContent = status.last.endKnown
            ? `Ultima zi notată: ${formatShort(status.last.end)}. Următorul ciclu e estimat în jurul datei de ${formatShort(status.nextStart)}.`
            : `De obicei durează ${daysText(analysis.avgPeriod)}. Dacă vrei, notează și ultima zi; nu e obligatoriu.`;
          break;
        case 'prep':
          eyebrow.textContent = 'Zile de pregătire';
          title.innerHTML = `Ciclul vine în <em>${daysText(status.daysUntil)}</em>`;
          detail.textContent = `Cel mai probabil ${formatLong(status.nextStart)}; intervalul probabil e ${formatRange(status.windowStart, status.windowEnd)}.`;
          tips = TIPS[Math.max(0, Math.min(3, Cycle.daysBetween(todayISO, status.windowStart)))];
          break;
        case 'due':
          eyebrow.textContent = 'Poate începe oricând';
          title.textContent = status.daysUntil > 0
            ? `Ciclul e așteptat în ~${daysText(status.daysUntil)}`
            : status.daysUntil === 0 ? 'Ciclul e așteptat azi' : 'Ciclul e așteptat zilele acestea';
          detail.textContent = `Intervalul probabil ține până pe ${formatShort(status.windowEnd)}. Apasă butonul când începe.`;
          tips = TIPS[0];
          break;
        case 'late':
          eyebrow.textContent = 'Întârziere';
          title.textContent = `Întârzie de ${daysText(status.lateBy)}`;
          detail.textContent = `Era așteptat până pe ${formatShort(status.windowEnd)}. Variații apar des; dacă întârzierea continuă, vorbește cu medicul.`;
          tips = TIPS[0];
          break;
        default:
          eyebrow.textContent = `Ziua ${status.cycleDay} a ciclului`;
          title.innerHTML = `Următorul ciclu în <em>${daysText(status.daysUntil)}</em>`;
          detail.textContent = `Cel mai probabil ${formatLong(status.nextStart)}; intervalul probabil e ${formatRange(status.windowStart, status.windowEnd)}.`;
      }
      $('timeline').innerHTML = timelineMarkup(analysis, status);
      $('timelineCaption').innerHTML = `<span>Ziua 1 · ${formatShort(status.last.start)}</span><span>Ziua ${status.cycleDay}</span><span>~${formatShort(status.nextStart)}</span>`;

      if (status.kind === 'period') {
        primary.textContent = status.last.endKnown ? 'Schimbă ultima zi' : 'S-a terminat azi';
        primary.dataset.action = status.last.endKnown ? 'pick-end' : 'end-today';
        secondary.textContent = status.last.endKnown ? 'Corectează din calendar' : 'S-a terminat în altă zi';
        secondary.dataset.action = status.last.endKnown ? 'go-calendar' : 'pick-end';
      } else {
        primary.textContent = 'A început ciclul';
        primary.dataset.action = 'start-today';
        secondary.textContent = 'A început în altă zi';
        secondary.dataset.action = 'pick-start';
      }
    }

    // Confidence
    const chip = $('confidenceChip');
    chip.dataset.level = analysis.confidence;
    chip.textContent = CONFIDENCE_LABEL[analysis.confidence];
    $('confidenceCount').textContent = analysis.cycleCount
      ? `${capitalize(cyclesText(analysis.cycleCount))} ${analysis.cycleCount === 1 ? 'notat' : 'notate'}`
      : 'Un singur început notat';
    let text;
    if (!analysis.learned) {
      const missing = Math.max(0, CYCLES_FOR_GOOD_PREDICTION - analysis.cycleCount);
      text = `Calculez cu ${daysText(analysis.avgCycle)}, durata din Setări.`;
      text += missing
        ? ` Luna trece la ritmul tău după ${cyclesText(CYCLES_FOR_GOOD_PREDICTION)} consecutive notate; mai ${missing === 1 ? 'lipsește unul' : `lipsesc ${missing}`}.`
        : ' Ciclurile notate variază prea mult ca să mă bazez pe ele deocamdată.';
    } else {
      text = `Ritmul tău: ~${analysis.avgCycle} zile, cu variație de ±${analysis.sd.toFixed(1)} zile. Interval probabil: ±${daysText(analysis.window)}.`;
      if (analysis.droppedCount) text += ` ${capitalize(cyclesText(analysis.droppedCount))} neobișnuit${analysis.droppedCount === 1 ? '' : 'e'} nu intră în calcul.`;
    }
    if (analysis.splitGaps || analysis.ignoredGaps) text += ' Unele luni par nenotate; le poți completa din Setări.';
    $('confidenceText').textContent = text;
    $('confidenceBox').hidden = status.kind === 'empty';

    // Calendar export notice
    const next = Cycle.predictions(analysis, status, todayISO, 1)[0];
    $('calNotice').hidden = !(data.calendarSyncedFor && next && next.start !== data.calendarSyncedFor);

    // Tips
    $('tipsBox').hidden = !tips;
    if (tips) $('tipsList').innerHTML = tips.map((tip) => `<li>${tip}</li>`).join('');

    // Upcoming
    const upcoming = Cycle.predictions(analysis, status, todayISO, 3);
    $('upcomingList').innerHTML = upcoming.map((p) => `
      <li>
        <span class="upcoming-month">${MONTHS_SHORT[Cycle.fromISO(p.start).getMonth()]}</span>
        <span class="upcoming-dates">${formatRange(p.start, p.end)}</span>
        <span class="upcoming-window">poate începe între ${formatRange(p.windowStart, p.windowEnd)}</span>
      </li>`).join('');
  }

  function openPicker(mode) {
    pickMode = mode;
    const todayISO = Cycle.today();
    const input = $('pickDate');
    input.max = todayISO;
    input.min = '';
    if (mode === 'end') {
      const last = data.periods[data.periods.length - 1];
      input.min = last ? last.start : '';
      $('pickLabel').textContent = 'Ultima zi a ciclului';
    } else {
      $('pickLabel').textContent = 'Prima zi a ciclului';
    }
    input.value = todayISO;
    $('pickForm').hidden = false;
    input.focus();
  }

  function closePicker() {
    pickMode = null;
    $('pickForm').hidden = true;
  }

  function savePicker() {
    const day = $('pickDate').value;
    const todayISO = Cycle.today();
    if (!day) { showToast('Alege o dată.'); return; }
    if (day > todayISO) { showToast('Data nu poate fi în viitor.'); return; }
    if (pickMode === 'start') {
      addPeriod(day, null);
      showToast(`Am notat prima zi a ciclului: ${formatShort(day)}.`);
    } else if (pickMode === 'end') {
      if (!endPeriodOn(day)) { showToast('Ultima zi trebuie să fie după prima zi a aceluiași ciclu, nu mai târziu de 15 zile.'); return; }
      showToast(`Am notat ultima zi a ciclului: ${formatShort(day)}.`);
    }
    closePicker();
    persist();
    render();
  }

  function handleHeroAction(action) {
    const todayISO = Cycle.today();
    switch (action) {
      case 'start-today':
        addPeriod(todayISO, null);
        showToast('Am notat începutul ciclului.');
        break;
      case 'end-today':
        if (!endPeriodOn(todayISO)) { showToast('Nu am găsit un ciclu în desfășurare.'); return; }
        showToast('Am notat ultima zi a ciclului.');
        break;
      case 'pick-start': openPicker('start'); return;
      case 'pick-end': openPicker('end'); return;
      case 'go-calendar':
        currentView = 'calendar';
        calendarMonth = null;
        render();
        return;
      default: return;
    }
    closePicker();
    persist();
    render();
  }

  /* ----- Calendar ----- */

  function renderCalendar(analysis, status, todayISO) {
    if (!calendarMonth) {
      const t = Cycle.fromISO(todayISO);
      calendarMonth = { year: t.getFullYear(), month: t.getMonth() };
    }
    const { year, month } = calendarMonth;
    $('calTitle').textContent = `${capitalize(MONTHS[month])} ${year}`;

    const periodDays = new Map(); // iso -> resolved period
    analysis.periods.forEach((p) => Cycle.range(p.start, p.end).forEach((d) => periodDays.set(d, p)));
    const predicted = new Set();
    const windowDays = new Set();
    const prep = new Set();
    Cycle.predictions(analysis, status, todayISO, 6).forEach((p) => {
      Cycle.range(p.start, p.end).forEach((d) => predicted.add(d));
      Cycle.range(p.windowStart, p.windowEnd).forEach((d) => windowDays.add(d));
      Cycle.range(p.prepStart, Cycle.addDays(p.windowStart, -1)).forEach((d) => prep.add(d));
    });

    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // Monday-first grid
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells = [];
    for (let i = 0; i < offset; i++) cells.push('<span class="day is-blank" aria-hidden="true"></span>');
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = Cycle.toISO(new Date(year, month, d));
      const classes = ['day'];
      const labels = [];
      const period = periodDays.get(iso);
      if (period) {
        classes.push('is-period');
        if (!period.endKnown && iso !== period.start) classes.push('is-assumed');
        labels.push(iso === period.start ? 'prima zi a ciclului' : period.endKnown ? 'ciclu' : 'ciclu (durată estimată)');
      } else {
        if (windowDays.has(iso)) { classes.push('is-window'); labels.push('interval probabil'); }
        if (predicted.has(iso)) { classes.push('is-predicted'); labels.push('estimat'); }
        if (prep.has(iso)) { classes.push('is-prep'); labels.push('pregătire'); }
      }
      if (iso === todayISO) { classes.push('is-today'); labels.push('azi'); }
      if (iso > todayISO) classes.push('is-future');
      const label = `${d} ${MONTHS[month]}${labels.length ? ', ' + labels.join(', ') : ''}`;
      cells.push(`<button type="button" class="${classes.join(' ')}" data-date="${iso}"
        aria-label="${label}"><span>${d}</span></button>`);
    }
    $('calGrid').innerHTML = cells.join('');
  }

  function openDaySheet(iso) {
    const todayISO = Cycle.today();
    if (iso > todayISO) {
      showToast('Poți nota doar zilele trecute sau ziua de azi.');
      return;
    }
    sheetDay = iso;
    const analysis = Cycle.analyze(data);
    const period = analysis.periods.find((p) => iso >= p.start && iso <= p.end);
    $('sheetTitle').textContent = capitalize(formatLong(iso));
    $('sheetInfo').textContent = period
      ? `Ciclu început pe ${formatShort(period.start)}${period.endKnown ? `, ultima zi ${formatShort(period.end)}` : `, durată estimată ${daysText(period.length)}`}.`
      : 'Nu e notată ca zi de ciclu.';
    const del = $('sheetDelete');
    del.hidden = !period;
    if (period) del.dataset.start = period.start;
    $('daySheet').hidden = false;
  }

  function closeDaySheet() {
    sheetDay = null;
    $('daySheet').hidden = true;
  }

  function handleDayAction(action) {
    const iso = sheetDay;
    if (!iso) return;
    if (action === 'close') { closeDaySheet(); return; }
    if (action === 'start') {
      addPeriod(iso, null);
      showToast(`${formatShort(iso)}: prima zi a ciclului.`);
    } else if (action === 'end') {
      if (!endPeriodOn(iso)) { showToast('Ultima zi trebuie să fie după prima zi a aceluiași ciclu, nu mai târziu de 15 zile.'); return; }
      showToast(`${formatShort(iso)}: ultima zi a ciclului.`);
    } else if (action === 'delete') {
      const start = $('sheetDelete').dataset.start;
      removePeriod(start);
      showToast(`Am șters ciclul din ${formatShort(start)}.`);
    }
    closeDaySheet();
    persist();
    render();
  }

  function shiftMonth(delta) {
    const d = new Date(calendarMonth.year, calendarMonth.month + delta, 1);
    calendarMonth = { year: d.getFullYear(), month: d.getMonth() };
    render();
  }

  /* ----- History ----- */

  function renderHistory(analysis, todayISO) {
    const stats = [];
    stats.push({ num: analysis.avgCycle, unit: 'zile', label: analysis.learned ? 'ciclul tău, în medie' : 'ciclu (valoare de pornire)' });
    stats.push({ num: analysis.avgPeriod, unit: 'zile', label: analysis.periodLearned ? 'menstruația, în medie' : 'menstruația (din Setări)' });
    if (analysis.cycleCount >= 2) {
      stats.push({ num: `${analysis.shortest}–${analysis.longest}`, unit: 'zile', label: 'cel mai scurt – cel mai lung' });
      stats.push({ num: `±${analysis.sd.toFixed(1)}`, unit: 'zile', label: 'variație' });
    }
    $('statsGrid').innerHTML = stats.map((s) => `
      <div class="stat"><span class="stat-num">${s.num}<small>${s.unit}</small></span><span class="stat-label">${s.label}</span></div>`).join('');
    $('statsNote').textContent = analysis.cycleCount >= CYCLES_FOR_GOOD_PREDICTION
      ? `Calculat din ultimele ${cyclesText(analysis.cycleCount)}. Ciclurile recente cântăresc mai mult.`
      : 'Cu cel puțin 3 cicluri notate, Luna poate estima bine. Cu 6 sau mai multe, estimarea devine stabilă.';

    const periods = analysis.periods;
    const dropped = analysis.droppedValues; // cycle lengths rejected as outliers
    const rows = [];
    for (let i = periods.length - 1; i >= 0; i--) {
      const p = periods[i];
      const next = periods[i + 1];
      const cycleLen = next ? Cycle.daysBetween(p.start, next.start) : null;
      const span = cycleLen ? Math.round(cycleLen / analysis.avgCycle) : 1;
      const skipped = cycleLen !== null && span >= 2 && cycleLen / analysis.avgCycle >= 1.6;
      const estimated = !p.endKnown;
      const outlier = cycleLen !== null && !skipped && (cycleLen < 15 || cycleLen > Cycle.MAX_CYCLE || dropped.includes(cycleLen));
      const barLen = cycleLen || Cycle.daysBetween(p.start, todayISO) + 1;
      const widthPct = Math.min(100, (barLen / Cycle.MAX_CYCLE) * 100);
      const periodPct = Math.min(100, (p.length / Cycle.MAX_CYCLE) * 100);
      rows.push(`
        <li class="cycle">
          <span class="cycle-start">${formatShort(p.start, true)}</span>
          <span class="cycle-bar"><i style="width:${widthPct}%"></i><b style="width:${periodPct}%"></b></span>
          <span class="cycle-len ${outlier || skipped ? 'is-outlier' : ''}">${cycleLen ? daysText(cycleLen) : 'ciclul curent'}</span>
          <span class="cycle-sub">menstruație ${estimated ? '~' : ''}${daysText(p.length)}${estimated ? ' (estimat)' : ` (${formatRange(p.start, p.end)})`}${skipped ? ` · probabil ${span} cicluri, ${span - 1 === 1 ? 'o lună nenotată' : `${span - 1} luni nenotate`}` : outlier ? ' · neobișnuit, nu intră în calcul' : ''}</span>
          <button type="button" class="cycle-del" data-del="${p.start}">Șterge</button>
        </li>`);
    }
    $('cycleList').innerHTML = rows.join('') || '<li class="hint">Niciun ciclu notat încă.</li>';
    $('addStart').max = todayISO;
    $('addEnd').max = todayISO;
  }

  function addCycleFromForm() {
    const todayISO = Cycle.today();
    const start = $('addStart').value;
    const end = $('addEnd').value;
    if (!start) { showToast('Completează prima zi.'); return; }
    if (start > todayISO || end > todayISO) { showToast('Datele nu pot fi în viitor.'); return; }
    if (end && end < start) { showToast('Ultima zi nu poate fi înaintea primei zile.'); return; }
    if (end && Cycle.daysBetween(start, end) + 1 > Cycle.MAX_PERIOD) { showToast(`O menstruație de peste ${Cycle.MAX_PERIOD} zile pare o greșeală.`); return; }
    addPeriod(start, end || null);
    $('addStart').value = '';
    $('addEnd').value = '';
    persist();
    render();
    showToast(`Am adăugat ciclul din ${formatShort(start)}.`);
  }

  /* ----- Settings ----- */

  function renderSettings() {
    if (document.activeElement !== $('setName')) $('setName').value = data.profile.name;
    if (!$('setMonths').contains(document.activeElement)) renderMonthEditor($('setMonths'), Cycle.today());
    $('setCycleValue').textContent = data.settings.cycleLength;
    $('setPeriodValue').textContent = data.settings.periodLength;
    renderShare();
    $('calSyncInfo').textContent = data.calendarSyncedFor
      ? `Ultimul export include ciclul estimat pe ${formatShort(data.calendarSyncedFor, true)}.`
      : 'Nu ai exportat încă în calendar.';
  }

  /** The app's own address, without query string or hash, for sharing. */
  function appUrl() {
    return `${location.origin}${location.pathname}`;
  }

  let renderedShareUrl = null;

  function renderShare() {
    const url = appUrl();
    if (url === renderedShareUrl) return;
    renderedShareUrl = url;
    $('shareUrl').value = url;
    $('qrBox').innerHTML = QR.toSVG(url, '#2a2135');
    $('shareLinkBtn').hidden = !(navigator.share);
  }

  function copyText(text, doneMessage, input) {
    const fallback = () => {
      if (input) { input.focus(); input.select(); }
      showToast('Textul e selectat. Copiază-l manual.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => showToast(doneMessage)).catch(fallback);
    } else {
      fallback();
    }
  }

  function shareLink() {
    if (!navigator.share) { copyText(appUrl(), 'Link copiat.', $('shareUrl')); return; }
    navigator.share({ title: 'Luna', text: 'Luna, calendar pentru ciclul menstrual', url: appUrl() }).catch(() => {
      // The user closed the share sheet; nothing to do.
    });
  }

  const LIMITS = { cycleLength: [15, 60], periodLength: [1, 10] };

  function step(field, delta) {
    const [min, max] = LIMITS[field];
    data.settings[field] = Math.min(max, Math.max(min, data.settings[field] + delta));
    persist();
    render();
  }

  /** Saves text as a file. Returns false if the browser blocked the download. */
  function downloadFile(text, filename, type) {
    try {
      const blob = new Blob([text], { type });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (err) {
      return false;
    }
  }

  function exportCalendar() {
    const todayISO = Cycle.today();
    const analysis = Cycle.analyze(data);
    const status = Cycle.status(analysis, todayISO);
    const upcoming = Cycle.predictions(analysis, status, todayISO, CALENDAR_EVENTS);
    if (!upcoming.length) {
      showToast('Notează mai întâi un ciclu.');
      return;
    }
    const ok = downloadFile(ICS.build(upcoming, Cycle.addDays), 'luna-calendar.ics', 'text/calendar');
    if (!ok) {
      showToast('Fișierul nu a putut fi creat în acest browser.');
      return;
    }
    data.calendarSyncedFor = upcoming[0].start;
    persist();
    render();
    showToast('Deschide fișierul descărcat ca să-l adaugi în calendar.');
  }

  function openExport() {
    $('exportText').value = Store.exportJSON(data);
    $('exportPanel').hidden = false;
  }

  function copyExport() {
    copyText($('exportText').value, 'Copiat. Păstrează textul într-un loc sigur.', $('exportText'));
  }

  function downloadExport() {
    const ok = downloadFile($('exportText').value, `luna-backup-${Cycle.today()}.json`, 'application/json');
    if (!ok) showToast('Descărcarea nu a pornit. Folosește butonul Copiază.');
  }

  function applyImport(text) {
    try {
      const imported = Store.importJSON(text);
      if (!imported.profile.name) imported.profile.name = data.profile.name;
      data = imported;
      calendarMonth = null;
      persist();
      currentView = 'today';
      render();
      showToast(`Am importat ${cyclesText(imported.periods.length)}.`);
    } catch (err) {
      showToast('Fișierul nu pare un backup Luna. Verifică și încearcă din nou.');
    }
  }

  function importFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => applyImport(String(reader.result));
    reader.onerror = () => showToast('Fișierul nu a putut fi citit.');
    reader.readAsText(file);
  }

  function deleteAll() {
    Store.clear();
    data = Store.load();
    calendarMonth = null;
    currentView = 'today';
    obStep = 1;
    $('obMonths').innerHTML = '';
    $('obName').value = '';
    $('confirmDelete').hidden = true;
    $('exportPanel').hidden = true;
    render();
    showToast('Toate datele au fost șterse.');
  }

  /* ---------- Events ---------- */

  function bindEvents() {
    // Onboarding
    $('obNameForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('obName').value.trim();
      if (!name) { showToast('Scrie un nume, chiar și unul scurt.'); return; }
      data.profile.name = name.slice(0, 40);
      obStep = 2;
      renderOnboarding(Cycle.today());
    });
    $('obCycleForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const result = readMonthEditor($('obMonths'));
      if (result.error) { showToast(result.error); return; }
      if (!result.changes.length) { showToast('Completează cel puțin o lună sau alege „Sar peste”.'); return; }
      finishOnboardingData(result.changes);
    });
    $('obSkip').addEventListener('click', () => finishOnboardingData([]));
    $('obFinish').addEventListener('click', () => {
      persist();
      currentView = 'today';
      render();
    });

    // Month editors: add or remove a cycle inside a month
    ['obMonths', 'setMonths'].forEach((id) => {
      $(id).addEventListener('click', (e) => {
        const add = e.target.closest('[data-add-entry]');
        if (add) { addMonthEntry(add.closest('.month-row')); return; }
        const remove = e.target.closest('[data-remove-entry]');
        if (remove) {
          const entry = remove.closest('.entry');
          const entries = entry.parentElement;
          if (entries.children.length === 1) {
            entry.querySelector('input').value = '';
          } else {
            entry.remove();
          }
        }
      });
    });

    // Tabs
    $('tabbar').addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      currentView = tab.dataset.view;
      closePicker();
      render();
      window.scrollTo(0, 0);
    });

    // Today
    $('primaryBtn').addEventListener('click', (e) => handleHeroAction(e.currentTarget.dataset.action));
    $('secondaryBtn').addEventListener('click', (e) => handleHeroAction(e.currentTarget.dataset.action));
    $('pickForm').addEventListener('submit', (e) => { e.preventDefault(); savePicker(); });
    $('pickCancel').addEventListener('click', closePicker);

    // Calendar
    $('calPrev').addEventListener('click', () => shiftMonth(-1));
    $('calNext').addEventListener('click', () => shiftMonth(1));
    $('calToday').addEventListener('click', () => { calendarMonth = null; render(); });
    $('calGrid').addEventListener('click', (e) => {
      const cell = e.target.closest('button.day');
      if (cell) openDaySheet(cell.dataset.date);
    });
    $('daySheet').addEventListener('click', (e) => {
      if (e.target === $('daySheet')) { closeDaySheet(); return; }
      const btn = e.target.closest('[data-day-action]');
      if (btn) handleDayAction(btn.dataset.dayAction);
    });

    // History
    $('addCycleForm').addEventListener('submit', (e) => { e.preventDefault(); addCycleFromForm(); });
    $('cycleList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      removePeriod(btn.dataset.del);
      persist();
      render();
      showToast(`Am șters ciclul din ${formatShort(btn.dataset.del)}.`);
    });

    // Settings
    $('setCycleForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const result = readMonthEditor($('setMonths'));
      if (result.error) { showToast(result.error); return; }
      if (!result.changes.length) { showToast('Nimic de salvat: nu ai modificat nicio lună.'); return; }
      const n = applyMonthChanges(result.changes);
      persist();
      render();
      showToast(n === 1 ? 'Am salvat o lună.' : `Am salvat ${n} luni.`);
    });
    $('setName').addEventListener('change', () => {
      data.profile.name = $('setName').value.trim().slice(0, 40);
      persist();
      render();
    });
    document.querySelectorAll('[data-step]').forEach((btn) => {
      btn.addEventListener('click', () => step(btn.dataset.field, Number(btn.dataset.step)));
    });
    document.querySelectorAll('[data-action="export-calendar"]').forEach((btn) => {
      btn.addEventListener('click', exportCalendar);
    });
    $('copyLinkBtn').addEventListener('click', () => copyText(appUrl(), 'Link copiat.', $('shareUrl')));
    $('shareLinkBtn').addEventListener('click', shareLink);
    $('shareUrl').addEventListener('focus', (e) => e.target.select());
    $('exportBtn').addEventListener('click', openExport);
    $('copyBtn').addEventListener('click', copyExport);
    $('downloadBtn').addEventListener('click', downloadExport);
    $('importFile').addEventListener('change', (e) => {
      importFromFile(e.target.files[0]);
      e.target.value = '';
    });
    $('importTextBtn').addEventListener('click', () => {
      const text = $('importText').value.trim();
      if (!text) { showToast('Lipește mai întâi textul backup-ului.'); return; }
      applyImport(text);
      $('importText').value = '';
    });
    $('deleteBtn').addEventListener('click', () => { $('confirmDelete').hidden = false; });
    $('cancelDelete').addEventListener('click', () => { $('confirmDelete').hidden = true; });
    $('confirmDeleteBtn').addEventListener('click', deleteAll);

    // Refresh when the app comes back to the foreground on a new day.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) render();
    });
  }

  /* ---------- Install button ---------- */

  let installPrompt = null; // deferred beforeinstallprompt event

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function updateInstallUI() {
    const available = Boolean(installPrompt) && !isStandalone();
    $('installBox').hidden = !available;
    $('installSettings').hidden = !available;
  }

  function setupInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // show our own button instead of the mini-infobar
      installPrompt = e;
      updateInstallUI();
    });
    window.addEventListener('appinstalled', () => {
      installPrompt = null;
      updateInstallUI();
      showToast('Luna e instalată. O găsești printre aplicațiile telefonului.');
    });
    document.querySelectorAll('[data-action="install"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!installPrompt) {
          showToast('Folosește meniul ⋮ din Chrome → Instalează aplicația.');
          return;
        }
        installPrompt.prompt();
        try {
          await installPrompt.userChoice;
        } finally {
          installPrompt = null;
          updateInstallUI();
        }
      });
    });
  }

  /* ---------- Offline support ---------- */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        // Offline mode unavailable here; the app still works online.
      });
    });
  }

  bindEvents();
  setupInstall();
  render();
  registerServiceWorker();
})();
