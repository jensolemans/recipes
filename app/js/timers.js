// Timers keep an end time, not a countdown, and are saved on the device, so a
// reload, a closed tab or another tab of the site picks them up where they are.

import { $, $$, esc, saved } from './util.js';

// Timers keep an end time, not a countdown, and are saved on the device, so a
// reload, a closed tab or another tab of the site picks them up where they are.
const timers = saved.get('timers', []);
let timerTick = null;

function saveTimers() { saved.set('timers', timers); }

function tickTimers() {
  renderTimers();
  if (timers.length && !timerTick) timerTick = setInterval(renderTimers, 500);
}

export function initTimers() {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== 'recipes.timers') return;
    timers.splice(0, timers.length, ...saved.get('timers', []));
    tickTimers();
  });
  // Closing the tab stops the alarm, so ask first while one is counting down.
  window.addEventListener('beforeunload', (ev) => {
    if (timers.some((t) => !t.done && t.paused == null)) { ev.preventDefault(); ev.returnValue = ''; }
  });
  tickTimers();
}

function startTimer(secs, label, recipeTitle, key = null) {
  timers.push({ id: Math.random().toString(36).slice(2), key, label, recipeTitle, end: Date.now() + secs * 1000, total: secs, paused: null, done: false });
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
  saveTimers();
  tickTimers();
}

function pauseTimer(t) {
  if (t.paused != null) { t.end = Date.now() + t.paused * 1000; t.paused = null; }
  else t.paused = (t.end - Date.now()) / 1000;
  saveTimers();
  renderTimers();
}

function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

let audio = null;
let lastBeep = 0;

function beep() {
  lastBeep = Date.now();
  // Right after a reload the page may not play sound or vibrate until it is
  // tapped; beeps queued before that would all sound at once.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audio;
    if (ctx.state === 'suspended') ctx.resume();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
    });
  } catch { /* no audio */ }
  try { navigator.vibrate?.([300, 150, 300, 150, 300]); } catch { /* ignore */ }
}

/** A soft click when an item goes in the basket (rising) or comes out (falling). */
export function tickSound(on) {
  try {
    // Ambient sound follows the phone's silent switch where the browser supports it.
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audio, t = ctx.currentTime;
    if (ctx.state === 'suspended') ctx.resume();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(on ? 660 : 990, t);
    o.frequency.exponentialRampToValueAtTime(on ? 990 : 660, t + 0.08);
    o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.start(t); o.stop(t + 0.16);
  } catch { /* no audio */ }
  try { navigator.vibrate?.(12); } catch { /* ignore */ }
}

// Phones (Android Chrome) only show notifications through the service worker.
async function notify(title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: 'icons/icon-192.png' });
    else new Notification(title, { body });
  } catch { /* ignore */ }
}

function renderTimers() {
  const el = $('#timers');
  const now = Date.now();
  for (const t of timers) {
    if (!t.done && t.paused == null && t.end <= now) {
      t.done = true;
      saveTimers();
      beep();
      if (document.hidden) notify('Timer done', `${t.label} for ${t.recipeTitle}`);
    }
  }
  // Keeps ringing until every finished timer is dismissed.
  if (timers.some((t) => t.done) && now - lastBeep > 2000) beep();
  el.innerHTML = timers.map((t) => {
    const left = t.paused != null ? t.paused : (t.end - now) / 1000;
    return `<div class="timer ${t.done ? 'is-done' : ''}" data-id="${t.id}">
      <span class="timer-label">${esc(t.label)}<small>${esc(t.recipeTitle)}</small></span>
      <span class="timer-clock">${t.done ? 'Done' : fmtClock(left)}</span>
      ${t.done ? '' : t.paused != null
        ? `<button class="timer-btn" data-act="pause" aria-label="Resume" title="Resume"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M8 5.5v13l10.5-6.5z"/></svg></button>`
        : `<button class="timer-btn" data-act="pause" aria-label="Pause" title="Pause"><svg viewBox="0 0 24 24" aria-hidden="true"><rect class="fill" x="6.5" y="5.5" width="3.8" height="13" rx="1"/><rect class="fill" x="13.7" y="5.5" width="3.8" height="13" rx="1"/></svg></button>`}
      <button class="timer-btn" data-act="close" aria-label="${t.done ? 'Dismiss' : 'Cancel'}" title="${t.done ? 'Dismiss' : 'Cancel'}">${t.done
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>'}</button>
    </div>`;
  }).join('');
  $$('.timer', el).forEach((row) => {
    const t = timers.find((x) => x.id === row.dataset.id);
    row.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.act !== 'close') { pauseTimer(t); return; }
        timers.splice(timers.indexOf(t), 1);
        saveTimers();
        renderTimers();
      };
    });
  });
  syncTimerChips();
  if (!timers.length && timerTick) { clearInterval(timerTick); timerTick = null; }
}

// A timer in the method starts once; tapping it again pauses or resumes it, and after it
// is done a tap starts it fresh.
export function wireTimerChips(root, path, recipeTitle) {
  $$('.timer-chip[data-secs]', root).forEach((b) => {
    b.dataset.key = `${path}#${b.dataset.timer}`;
    b.onclick = () => {
      const t = timers.find((x) => x.key === b.dataset.key);
      if (t && !t.done) { pauseTimer(t); return; }
      if (t) timers.splice(timers.indexOf(t), 1);
      startTimer(Number(b.dataset.secs), b.dataset.label, recipeTitle, b.dataset.key);
    };
  });
  syncTimerChips();
}

function syncTimerChips() {
  const now = Date.now();
  $$('.timer-chip[data-key]').forEach((b) => {
    const t = timers.find((x) => x.key === b.dataset.key);
    const left = t ? (t.done ? 0 : t.paused != null ? t.paused : (t.end - now) / 1000) : 0;
    b.classList.toggle('is-running', !!t);
    b.classList.toggle('is-paused', !!t && t.paused != null);
    b.classList.toggle('is-done', !!t && t.done);
    b.querySelector('.tc-left').setAttribute('stroke-dasharray', `${t ? Math.max(0, Math.min(100, (left / t.total) * 100)).toFixed(1) : 100} 100`);
    b.querySelector('.tc-text').textContent = !t ? b.dataset.text : t.done ? 'Done' : fmtClock(left);
    b.title = !t ? `Start a ${b.dataset.text} timer` : t.done ? 'Start again' : t.paused != null ? 'Resume timer' : 'Pause timer';
  });
}
