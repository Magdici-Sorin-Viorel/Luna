/*
 * Luna — UI layer. Renders the views and wires up user actions.
 * Interface text is Romanian; code and comments are English.
 */
(function () {
  'use strict';

  const Store = window.LunaStorage;
  const Cycle = window.LunaCycle;
  const ICS = window.LunaICS;

  const CALENDAR_EVENTS = 3; // predicted cycles included in the calendar export

  /* ---------- Romanian text helpers ---------- */

  const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie',
    'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
  const MONTHS_SHORT = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun',
    'iul', 'aug', 'sept', 'oct', 'nov', 'dec'];
  const WEEKDAYS = ['duminică', 'luni', 'marți', 'miercuri', 'joi', 'vineri', 'sâmbătă'];

  /** Preparation tips, keyed by days left until the predicted start. */
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

  function formatShort(iso, withYear) {
    const d = Cycle.fromISO(iso);
    const year = withYear ? ` ${d.getFullYear()}` : '';
    return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}${year}`;
  }

  function formatLong(iso) {
    const d = Cycle.fromISO(iso);
    return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  }

  /* ---------- State ---------- */

  let data = Store.load();
  let currentView = 'today';
  let calendarMonth = null; // { year, month }
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
    }, 2600);
  }

  /* ---------- Rendering ---------- */

  function showView(name) {
    ['onboarding', 'today', 'calendar', 'settings'].forEach((v) => {
      $(`view-${v}`).hidden = v !== name;
    });
    document.querySelectorAll('.tab').forEach((tab) => {
      const active = tab.dataset.view === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-current', active ? 'page' : 'false');
    });
  }

  function render() {
    const todayISO = Cycle.today();
    if (Cycle.syncOngoing(data, todayISO)) persist();

    $('todayLabel').textContent = formatLong(todayISO);

    const hasData = data.days.length > 0;
    $('tabbar').hidden = !hasData;
    if (!hasData) {
      showView('onboarding');
      renderOnboarding(todayISO);
      return;
    }
    if (currentView === 'onboarding') currentView = 'today';
    showView(currentView);

    const analysis = Cycle.analyze(data);
    const status = Cycle.status(data, analysis, todayISO);
    renderToday(analysis, status, todayISO);
    renderCalendar(analysis, status, todayISO);
    renderSettings(analysis);
  }

  /* ----- Onboarding ----- */

  function renderOnboarding(todayISO) {
    const input = $('obStart');
    input.max = todayISO;
    if (!input.value) input.value = Cycle.addDays(todayISO, -10);
    $('obCycleValue').textContent = data.settings.cycleLength;
    $('obPeriodValue').textContent = data.settings.periodLength;
  }

  function completeOnboarding() {
    const todayISO = Cycle.today();
    const start = $('obStart').value;
    if (!start) {
      showToast('Alege data la care a început ultimul ciclu.');
      return;
    }
    if (start > todayISO) {
      showToast('Data nu poate fi în viitor.');
      return;
    }
    const days = [];
    for (let i = 0; i < data.settings.periodLength; i++) {
      const day = Cycle.addDays(start, i);
      if (day > todayISO) break;
      days.push(day);
    }
    data.days = days;
    // If the period would still be running today, keep it open.
    data.ongoing = Cycle.daysBetween(start, todayISO) < data.settings.periodLength;
    currentView = 'today';
    persist();
    render();
    showToast('Gata! Luna a început să urmărească ciclul tău.');
  }

  /** Example history so the app can be explored without real data. */
  function loadDemo() {
    const todayISO = Cycle.today();
    const lastStart = Cycle.addDays(todayISO, -26);
    const starts = [lastStart];
    [27, 30, 28].forEach((len) => starts.unshift(Cycle.addDays(starts[0], -len)));
    const lengths = [5, 4, 5, 5];
    const days = [];
    starts.forEach((start, i) => {
      for (let d = 0; d < lengths[i]; d++) days.push(Cycle.addDays(start, d));
    });
    data.days = days.sort();
    data.ongoing = false;
    currentView = 'today';
    persist();
    render();
    showToast('Am încărcat date de exemplu. Le poți șterge din Setări.');
  }

  /* ----- Today ----- */

  function ringMarkup(analysis, status) {
    const size = 220;
    const c = size / 2;
    const r = 92;
    const circumference = 2 * Math.PI * r;
    const total = analysis.avgCycle;

    const arc = (from, to, cls) => {
      const length = Math.max(0, (to - from) / total * circumference);
      const offset = -(from / total) * circumference;
      return `<circle class="${cls}" cx="${c}" cy="${c}" r="${r}" fill="none"
        stroke-dasharray="${length} ${circumference}" stroke-dashoffset="${offset}"
        transform="rotate(-90 ${c} ${c})"/>`;
    };

    const progress = Math.min(status.cycleDay, total) / total;
    const angle = progress * 2 * Math.PI - Math.PI / 2;
    const dotX = c + r * Math.cos(angle);
    const dotY = c + r * Math.sin(angle);

    return `<svg viewBox="0 0 ${size} ${size}" role="img"
        aria-label="Ziua ${status.cycleDay} dintr-un ciclu de aproximativ ${total} zile">
      <circle class="ring-track" cx="${c}" cy="${c}" r="${r}" fill="none"/>
      ${arc(0, Math.min(analysis.avgPeriod, total), 'ring-period')}
      ${arc(total - Cycle.PREP_DAYS, total, 'ring-prep')}
      ${arc(0, progress * total, 'ring-progress')}
      <circle class="ring-dot" cx="${dotX}" cy="${dotY}" r="9"/>
    </svg>`;
  }

  function renderToday(analysis, status, todayISO) {
    $('ring').innerHTML = ringMarkup(analysis, status);
    $('ringNum').textContent = status.cycleDay;
    $('ringSub').textContent = `din ~${analysis.avgCycle}`;

    const card = $('statusCard');
    card.dataset.kind = status.kind;

    const eyebrow = $('statusEyebrow');
    const title = $('statusTitle');
    const detail = $('statusDetail');
    const button = $('periodBtn');
    let tips = null;

    switch (status.kind) {
      case 'period':
        eyebrow.textContent = 'Menstruație';
        title.textContent = `Ziua ${status.periodDay}`;
        detail.textContent = data.ongoing
          ? `De obicei durează ~${daysText(analysis.avgPeriod)}. Apasă butonul când se oprește.`
          : `Ziua de azi e marcată. Următorul ciclu e estimat pe ${formatShort(status.nextStart)}.`;
        button.textContent = data.ongoing ? 'S-a terminat ciclul' : 'Ciclul continuă';
        button.dataset.action = data.ongoing ? 'end' : 'resume';
        break;
      case 'prep':
        eyebrow.textContent = 'Zile de pregătire';
        title.textContent = status.daysUntil === 0
          ? 'Ciclul e estimat azi'
          : `Ciclul vine în ~${daysText(status.daysUntil)}`;
        detail.textContent = `Estimat pentru ${formatLong(status.nextStart)}.`;
        button.textContent = 'A început ciclul';
        button.dataset.action = 'start';
        tips = TIPS[status.daysUntil];
        break;
      case 'late':
        eyebrow.textContent = 'Întârziere';
        title.textContent = `Întârzie de ${daysText(status.lateBy)}`;
        detail.textContent = `Era estimat pe ${formatShort(status.nextStart)}. Variații de câteva zile sunt frecvente.`;
        button.textContent = 'A început ciclul';
        button.dataset.action = 'start';
        tips = TIPS[0];
        break;
      default:
        eyebrow.textContent = `Ziua ${status.cycleDay} a ciclului`;
        title.textContent = `Următorul ciclu în ~${daysText(status.daysUntil)}`;
        detail.textContent = `Estimat pentru ${formatLong(status.nextStart)}.`;
        button.textContent = 'A început ciclul';
        button.dataset.action = 'start';
    }

    // Preparation tips
    const tipsBox = $('tipsBox');
    tipsBox.hidden = !tips;
    if (tips) {
      $('tipsList').innerHTML = tips.map((tip) => `<li>${tip}</li>`).join('');
    }

    // Calendar export is outdated when the next predicted start moved.
    const next = Cycle.predictions(analysis, status, todayISO, 1)[0];
    $('calNotice').hidden = !(data.calendarSyncedFor && next && next.start !== data.calendarSyncedFor);

    // Averages
    $('avgCycle').textContent = analysis.avgCycle;
    $('avgPeriod').textContent = analysis.avgPeriod;
    $('avgNote').textContent = analysis.learned
      ? `Calculat din ultimele ${analysis.cycleCount === 1 ? 'un ciclu' : analysis.cycleCount + ' cicluri'}.`
      : 'Folosesc valorile din Setări până înregistrezi încă un ciclu.';

    // Upcoming
    const upcoming = Cycle.predictions(analysis, status, todayISO, 3);
    $('upcomingList').innerHTML = upcoming.map((p) => `
      <li>
        <span class="upcoming-dates">${formatShort(p.start)} – ${formatShort(p.end)}</span>
        <span class="upcoming-prep">pregătire din ${formatShort(p.prepStart)}</span>
      </li>`).join('');

    // History (most recent first)
    const periods = analysis.periods;
    const rows = [];
    for (let i = periods.length - 1; i >= 0 && rows.length < 6; i--) {
      const p = periods[i];
      const next = periods[i + 1];
      const cycleLen = next ? Cycle.daysBetween(p.start, next.start) : null;
      const isOpen = !next && data.ongoing;
      rows.push(`
        <li>
          <span class="history-date">${formatShort(p.start, true)}</span>
          <span class="history-meta">${isOpen ? 'în desfășurare' : daysText(p.length)}</span>
          <span class="history-cycle">${cycleLen ? `ciclu de ${daysText(cycleLen)}` : 'ciclul curent'}</span>
        </li>`);
    }
    $('historyList').innerHTML = rows.join('');
  }

  function handlePeriodButton(action) {
    const todayISO = Cycle.today();
    if (action === 'start') {
      if (!data.days.includes(todayISO)) data.days.push(todayISO);
      data.days.sort();
      data.ongoing = true;
      showToast('Am notat începutul ciclului.');
    } else if (action === 'end') {
      data.ongoing = false;
      showToast('Am notat finalul ciclului.');
    } else if (action === 'resume') {
      data.ongoing = true;
      showToast('Ciclul continuă. Zilele se adaugă automat.');
    }
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

    const periodDays = new Set(data.days);
    const predicted = new Set();
    const prep = new Set();
    Cycle.predictions(analysis, status, todayISO, 6).forEach((p) => {
      for (let d = p.start; d <= p.end; d = Cycle.addDays(d, 1)) predicted.add(d);
      for (let d = p.prepStart; d < p.start; d = Cycle.addDays(d, 1)) prep.add(d);
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
      if (periodDays.has(iso)) { classes.push('is-period'); labels.push('menstruație'); }
      else if (predicted.has(iso)) { classes.push('is-predicted'); labels.push('estimat'); }
      if (prep.has(iso) && !periodDays.has(iso)) { classes.push('is-prep'); labels.push('pregătire'); }
      if (iso === todayISO) { classes.push('is-today'); labels.push('azi'); }
      if (iso > todayISO) classes.push('is-future');
      const label = `${d} ${MONTHS[month]}${labels.length ? ', ' + labels.join(', ') : ''}`;
      cells.push(`<button type="button" class="${classes.join(' ')}" data-date="${iso}"
        aria-label="${label}"><span>${d}</span></button>`);
    }
    $('calGrid').innerHTML = cells.join('');
  }

  function toggleDay(iso) {
    const todayISO = Cycle.today();
    if (iso > todayISO) {
      showToast('Poți marca doar zilele trecute sau ziua de azi.');
      return;
    }
    const index = data.days.indexOf(iso);
    if (index >= 0) {
      data.days.splice(index, 1);
      // Editing the latest period by hand stops the automatic extension.
      const periods = Cycle.groupPeriods(data.days.concat(iso));
      const last = periods[periods.length - 1];
      if (data.ongoing && last && iso >= last.start) data.ongoing = false;
      showToast(`${formatShort(iso)} nu mai e zi de ciclu.`);
    } else {
      data.days.push(iso);
      data.days.sort();
      showToast(`${formatShort(iso)} marcată ca zi de ciclu.`);
    }
    persist();
    render();
  }

  function shiftMonth(delta) {
    const d = new Date(calendarMonth.year, calendarMonth.month + delta, 1);
    calendarMonth = { year: d.getFullYear(), month: d.getMonth() };
    render();
  }

  /* ----- Settings ----- */

  function renderSettings() {
    $('setCycleValue').textContent = data.settings.cycleLength;
    $('setPeriodValue').textContent = data.settings.periodLength;
    $('calSyncInfo').textContent = data.calendarSyncedFor
      ? `Ultimul export include ciclul estimat pe ${formatShort(data.calendarSyncedFor, true)}.`
      : 'Nu ai exportat încă în calendar.';
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
    const status = Cycle.status(data, analysis, todayISO);
    const upcoming = Cycle.predictions(analysis, status, todayISO, CALENDAR_EVENTS);
    if (!upcoming.length) {
      showToast('Marchează mai întâi un ciclu.');
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

  const LIMITS = {
    cycleLength: [15, 60],
    periodLength: [1, 10],
  };

  function step(field, delta) {
    const [min, max] = LIMITS[field];
    data.settings[field] = Math.min(max, Math.max(min, data.settings[field] + delta));
    persist();
    if (data.days.length) render();
    else renderOnboarding(Cycle.today());
  }

  function openExport() {
    const text = Store.exportJSON(data);
    $('exportText').value = text;
    $('exportPanel').hidden = false;
  }

  function copyExport() {
    const area = $('exportText');
    const fallback = () => {
      area.focus();
      area.select();
      showToast('Textul e selectat. Copiază-l manual.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(area.value)
        .then(() => showToast('Copiat. Păstrează textul într-un loc sigur.'))
        .catch(fallback);
    } else {
      fallback();
    }
  }

  function downloadExport() {
    const ok = downloadFile($('exportText').value, `luna-backup-${Cycle.today()}.json`, 'application/json');
    if (!ok) showToast('Descărcarea nu a pornit. Folosește butonul Copiază.');
  }

  function applyImport(text) {
    try {
      const imported = Store.importJSON(text);
      data = imported;
      calendarMonth = null;
      persist();
      currentView = 'today';
      render();
      showToast(`Am importat ${imported.days.length} zile de ciclu.`);
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
    $('confirmDelete').hidden = true;
    $('exportPanel').hidden = true;
    render();
    showToast('Toate datele au fost șterse.');
  }

  /* ---------- Events ---------- */

  function bindEvents() {
    $('tabbar').addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      currentView = tab.dataset.view;
      render();
      window.scrollTo(0, 0);
    });

    $('periodBtn').addEventListener('click', (e) => handlePeriodButton(e.currentTarget.dataset.action));

    $('calPrev').addEventListener('click', () => shiftMonth(-1));
    $('calNext').addEventListener('click', () => shiftMonth(1));
    $('calToday').addEventListener('click', () => { calendarMonth = null; render(); });
    $('calGrid').addEventListener('click', (e) => {
      const cell = e.target.closest('button.day');
      if (cell) toggleDay(cell.dataset.date);
    });

    document.querySelectorAll('[data-step]').forEach((btn) => {
      btn.addEventListener('click', () => step(btn.dataset.field, Number(btn.dataset.step)));
    });

    $('obForm').addEventListener('submit', (e) => {
      e.preventDefault();
      completeOnboarding();
    });
    $('obDemo').addEventListener('click', loadDemo);

    document.querySelectorAll('[data-action="export-calendar"]').forEach((btn) => {
      btn.addEventListener('click', exportCalendar);
    });
    $('exportBtn').addEventListener('click', openExport);
    $('copyBtn').addEventListener('click', copyExport);
    $('downloadBtn').addEventListener('click', downloadExport);
    $('importFile').addEventListener('change', (e) => {
      importFromFile(e.target.files[0]);
      e.target.value = '';
    });
    $('importTextBtn').addEventListener('click', () => {
      const text = $('importText').value.trim();
      if (!text) {
        showToast('Lipește mai întâi textul backup-ului.');
        return;
      }
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
  render();
  registerServiceWorker();
})();
