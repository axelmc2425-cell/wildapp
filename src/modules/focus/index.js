import { registerModule } from '../../shell/modules.js';
import { h } from '../../ui/dom.js';
import { DEFAULTS, phaseMinutes } from './timer.js';
import { createController } from './controller.js';
import { listSessions, deleteSession, setSessionDone, getSetting, setSetting, focusSearch } from './repo.js';
import { todayMinutes, lastDays, streak, bestStreak, finishedCount, goalProgress } from './stats.js';
import { noiseSamples } from './sound.js';

const SETTINGS_KEY = 'focus.timer';
const PHASE_LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };
let controller = null;
let ticker = null;
let audio = null;

function notifyPermission() {
  try { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; } catch { return 'unsupported'; }
}

function notifyFinished(e) {
  if (notifyPermission() !== 'granted') return;
  const work = e.phase === 'work';
  try {
    new Notification(work ? 'Focus session done' : 'Break is over', // eslint-disable-line no-new
      { body: work ? `${e.minutes} min. Time for a break.` : 'Ready for the next focus session?' });
  } catch { /* notifications not available in this window */ }
}

function ensureController(db, settings) {
  if (controller) return controller;
  controller = createController({ db, settings });
  controller.subscribe((e) => { if (e.type === 'finished') { beep(); notifyFinished(e); } });
  ticker = setInterval(() => controller.tick(), 500);
  return controller;
}

function audioCtx() {
  if (!audio) audio = { ctx: new (window.AudioContext || window.webkitAudioContext)(), src: null, gain: null, kind: 'off' };
  return audio;
}

function beep() {
  try {
    const a = audioCtx();
    const o = a.ctx.createOscillator();
    const g = a.ctx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.15;
    o.connect(g).connect(a.ctx.destination);
    o.start();
    o.stop(a.ctx.currentTime + 0.4);
  } catch { /* no audio available */ }
}

function setSound(kind, volume) {
  const a = audioCtx();
  if (a.src) { a.src.stop(); a.src = null; }
  a.kind = kind;
  if (kind === 'off') return;
  const rate = a.ctx.sampleRate;
  const buf = a.ctx.createBuffer(1, rate * 4, rate);
  buf.copyToChannel(noiseSamples(kind, rate * 4), 0);
  a.src = a.ctx.createBufferSource();
  a.src.buffer = buf;
  a.src.loop = true;
  a.gain = a.gain || a.ctx.createGain();
  a.gain.gain.value = volume;
  a.src.connect(a.gain).connect(a.ctx.destination);
  a.ctx.resume();
  a.src.start();
}

const fmt = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

async function render(root, ctx) {
  const db = ctx.db;
  const settings = { ...DEFAULTS, ...(await getSetting(db, SETTINGS_KEY, DEFAULTS)) };
  const c = ensureController(db, settings);

  const phaseEl = h('div', { class: 'phase' });
  const clockEl = h('div', { class: 'clock' });
  const oneInput = h('input', { class: 'one', type: 'text', placeholder: 'What is the one thing?', 'aria-label': 'The one thing', value: c.task() });
  // Clicking a control leaves focus on that button; blur it so Space and the letter keys keep working.
  const act = (fn) => () => { fn(); document.activeElement?.blur?.(); };
  const toggle = () => (c.state().status === 'running' ? c.pause() : c.start(oneInput.value.trim()));
  const startBtn = h('button', { class: 'primary', onclick: act(toggle) });
  const skipBtn = h('button', { onclick: act(() => c.skip()) }, 'Skip');
  const resetBtn = h('button', { onclick: act(() => c.reset()) }, 'Reset');
  const keyHandler = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target?.closest?.('input, textarea, select, button, [contenteditable="true"]')) return;
    if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 's' || e.key === 'S') c.skip();
    else if (e.key === 'r' || e.key === 'R') c.reset();
  };
  window.addEventListener('keydown', keyHandler);
  const soundSel = h('select', { 'aria-label': 'Ambient sound', onchange: () => setSound(soundSel.value, Number(vol.value)) },
    ...[['off', 'No sound'], ['white', 'White noise'], ['brown', 'Brown noise'], ['rain', 'Rain']].map(([v, l]) => h('option', { value: v }, l)));
  const vol = h('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: '0.4', 'aria-label': 'Volume',
    oninput: () => { if (audio && audio.gain) audio.gain.gain.value = Number(vol.value); } });
  soundSel.value = audio ? audio.kind : 'off';
  const notifyBtn = h('button', { onclick: async () => {
    try { await Notification.requestPermission(); } catch { /* unsupported */ }
    paintNotify();
  } });
  function paintNotify() {
    const perm = notifyPermission();
    notifyBtn.hidden = perm === 'unsupported';
    notifyBtn.disabled = perm === 'granted' || perm === 'denied';
    notifyBtn.textContent = perm === 'granted' ? 'Alerts on' : perm === 'denied' ? 'Alerts blocked' : 'Alert me when done';
  }
  paintNotify();

  const tilesEl = h('div', { class: 'tiles' });
  const barsEl = h('div', { class: 'bars' });
  const logEl = h('ul', { class: 'list' });
  const cfg = h('div', { class: 'row' });
  const mk = (key, label, min = 1, max = 180) => {
    const i = h('input', { type: 'number', min: String(min), max: String(max), value: String(settings[key]), style: 'width:64px', 'aria-label': label });
    i.addEventListener('change', async () => {
      const n = Number(i.value);
      const v = i.value.trim() === '' || !Number.isFinite(n) ? DEFAULTS[key] : Math.max(min, Math.min(max, Math.round(n)));
      settings[key] = v;
      i.value = String(v);
      await setSetting(db, SETTINGS_KEY, settings);
      c.setSettings({ ...settings }); // applies now if idle, otherwise after the current session
    });
    return h('label', { class: 'field' }, label, i);
  };
  cfg.append(mk('work', 'Focus (min)'), mk('short', 'Short break'), mk('long', 'Long break'), mk('longEvery', 'Long break every'));
  const goalCfg = h('div', { class: 'row' }, mk('goal', 'Daily goal (min, 0 = off)', 0, 1000));

  async function paintStats() {
    const sessions = await listSessions(db, { since: Date.now() - 400 * 86400000, limit: 5000 }); // long enough for streaks
    const now = Date.now();
    const today = todayMinutes(sessions, now);
    const goal = goalProgress(today, settings.goal);
    const tiles = [{ value: `${today} min`, label: 'Focused today' }];
    if (goal) tiles.push({ value: `${today} / ${settings.goal}`, label: goal.reached ? 'Goal reached' : 'Daily goal', pct: goal.pct, reached: goal.reached });
    tiles.push({ value: String(streak(sessions, now)), label: 'Day streak' },
      { value: String(bestStreak(sessions)), label: 'Best streak' },
      { value: String(finishedCount(sessions, now)), label: 'Finished (7 days)' });
    tilesEl.innerHTML = '';
    for (const t of tiles) {
      tilesEl.append(h('div', { class: t.reached ? 'tile reached' : 'tile' }, h('b', {}, t.value), h('span', {}, t.label),
        t.pct === undefined ? null : h('div', { class: 'meter' }, h('i', { style: `width:${t.pct}%` }))));
    }
    const days = lastDays(sessions, now, 7);
    const max = Math.max(30, ...days.map(d => d.minutes));
    barsEl.innerHTML = '';
    for (const d of days) {
      barsEl.append(h('div', { class: 'bar', title: `${d.day}: ${d.minutes} min` },
        h('i', { style: `height:${Math.round((d.minutes / max) * 100)}%` }), d.day.slice(8)));
    }
    logEl.innerHTML = '';
    const recent = sessions.filter(s => s.kind === 'work').slice(0, 25);
    if (!recent.length) logEl.append(h('li', { class: 'muted' }, 'No sessions yet. Start one!'));
    for (const s of recent) {
      logEl.append(h('li', {},
        h('button', { class: s.done ? 'check on' : 'check', 'aria-pressed': String(!!s.done), 'aria-label': 'Finished',
          title: s.done ? 'Finished (click to undo)' : 'Mark as finished',
          onclick: async () => { await setSessionDone(db, s.id, !s.done); paintStats(); } }, s.done ? '✓' : '○'),
        h('span', { class: 'grow' }, s.task || 'Focus session', s.completed ? null : h('span', { class: 'pill' }, ' stopped early')),
        h('span', { class: 'muted' }, `${new Date(s.started).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${s.minutes} min`),
        h('button', { class: 'danger', title: 'Delete', 'aria-label': 'Delete session', onclick: async () => { await deleteSession(db, s.id); paintStats(); } }, '✕')));
    }
  }

  function paint() {
    const s = c.state();
    phaseEl.textContent = PHASE_LABEL[s.phase] + (s.status === 'paused' ? ' (paused)' : '');
    clockEl.textContent = fmt(c.remaining());
    startBtn.textContent = s.status === 'running' ? 'Pause' : s.status === 'paused' ? 'Resume' : 'Start';
    document.title = s.status === 'running' ? `${fmt(c.remaining())} · MyBrain` : 'MyBrain';
  }

  const off = c.subscribe((e) => { paint(); if (e.type === 'finished' || e.type === 'saved') paintStats(); });
  const paintTimer = setInterval(paint, 250);
  paint();
  paintStats();

  root.innerHTML = '';
  root.append(h('div', { class: 'mod' },
    h('h2', {}, '🎯 Focus Room'),
    h('p', { class: 'sub' }, 'One thing at a time. Sessions are saved on this computer.'),
    tilesEl,
    h('div', { class: 'grid2' },
      h('div', {},
        h('div', { class: 'card timer' }, phaseEl, clockEl, oneInput,
          h('div', { class: 'row', style: 'justify-content:center' }, startBtn, skipBtn, resetBtn),
          h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' }, soundSel, vol, notifyBtn),
          h('p', { class: 'hint' }, 'Space start or pause · S skip · R reset (when no field is focused)')),
        h('div', { class: 'card' }, h('h3', {}, 'Timer lengths'), cfg, h('h3', { style: 'margin-top:14px' }, 'Daily goal'), goalCfg)),
      h('div', {},
        h('div', { class: 'card' }, h('h3', {}, 'Last 7 days (minutes)'), barsEl),
        h('div', { class: 'card' }, h('h3', {}, 'Session log'), logEl)))));

  return () => { off(); clearInterval(paintTimer); window.removeEventListener('keydown', keyHandler); document.title = 'MyBrain'; };
}

registerModule({ id: 'focus', name: 'Focus Room', icon: '🎯', ready: true, searchProvider: focusSearch, render });
