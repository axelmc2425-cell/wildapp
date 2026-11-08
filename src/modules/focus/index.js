import { registerModule } from '../../shell/modules.js';
import { h } from '../../ui/dom.js';
import { DEFAULTS, phaseMinutes } from './timer.js';
import { createController } from './controller.js';
import { listSessions, deleteSession, getSetting, setSetting, focusSearch } from './repo.js';
import { todayMinutes, lastDays, streak } from './stats.js';
import { noiseSamples } from './sound.js';

const SETTINGS_KEY = 'focus.timer';
const PHASE_LABEL = { work: 'Focus', short: 'Short break', long: 'Long break' };
let controller = null;
let ticker = null;
let audio = null;

function ensureController(db, settings) {
  if (controller) return controller;
  controller = createController({ db, settings });
  controller.subscribe((e) => { if (e.type === 'finished') beep(); });
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
  const startBtn = h('button', { class: 'primary', onclick: () => (c.state().status === 'running' ? c.pause() : c.start(oneInput.value.trim())) });
  const skipBtn = h('button', { onclick: () => c.skip() }, 'Skip');
  const resetBtn = h('button', { onclick: () => c.reset() }, 'Reset');
  const soundSel = h('select', { 'aria-label': 'Ambient sound', onchange: () => setSound(soundSel.value, Number(vol.value)) },
    ...[['off', 'No sound'], ['white', 'White noise'], ['brown', 'Brown noise'], ['rain', 'Rain']].map(([v, l]) => h('option', { value: v }, l)));
  const vol = h('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: '0.4', 'aria-label': 'Volume',
    oninput: () => { if (audio && audio.gain) audio.gain.gain.value = Number(vol.value); } });
  soundSel.value = audio ? audio.kind : 'off';

  const tilesEl = h('div', { class: 'tiles' });
  const barsEl = h('div', { class: 'bars' });
  const logEl = h('ul', { class: 'list' });
  const cfg = h('div', { class: 'row' });
  const mk = (key, label) => {
    const i = h('input', { type: 'number', min: '1', max: '180', value: String(settings[key]), style: 'width:64px', 'aria-label': label });
    i.addEventListener('change', async () => {
      const v = Math.max(1, Math.min(180, Number(i.value) || DEFAULTS[key]));
      settings[key] = v;
      i.value = String(v);
      await setSetting(db, SETTINGS_KEY, settings);
      if (c.state().status !== 'running') c.setSettings({ ...settings });
    });
    return h('label', { class: 'field' }, label, i);
  };
  cfg.append(mk('work', 'Focus (min)'), mk('short', 'Short break'), mk('long', 'Long break'), mk('longEvery', 'Long break every'));

  async function paintStats() {
    const sessions = await listSessions(db, { since: Date.now() - 40 * 86400000 });
    const now = Date.now();
    tilesEl.innerHTML = '';
    for (const [value, label] of [[todayMinutes(sessions, now) + ' min', 'Focused today'], [String(streak(sessions, now)), 'Day streak'],
      [String(sessions.filter(s => s.kind === 'work' && s.completed).length), 'Sessions (40 days)']]) {
      tilesEl.append(h('div', { class: 'tile' }, h('b', {}, value), h('span', {}, label)));
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
        h('span', { class: 'grow' }, s.task || 'Focus session'),
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

  const off = c.subscribe((e) => { paint(); if (e.type === 'finished') paintStats(); });
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
          h('div', { class: 'row', style: 'justify-content:center;margin-top:12px' }, soundSel, vol)),
        h('div', { class: 'card' }, h('h3', {}, 'Timer lengths'), cfg)),
      h('div', {},
        h('div', { class: 'card' }, h('h3', {}, 'Last 7 days (minutes)'), barsEl),
        h('div', { class: 'card' }, h('h3', {}, 'Session log'), logEl)))));

  return () => { off(); clearInterval(paintTimer); document.title = 'MyBrain'; };
}

registerModule({ id: 'focus', name: 'Focus Room', icon: '🎯', ready: true, searchProvider: focusSearch, render });
