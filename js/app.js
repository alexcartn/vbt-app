import { Tracker } from './signal.js';
import { Sensor, bleSupported } from './ble.js';
import { generateSet } from './sim.js';
import * as store from './store.js';
import { EXERCISES, bestPerLoad, fitProfile, loadForVelocity } from './profile.js';

const $ = s => document.querySelector(s);
const fmt = (v, d = 2) => (v == null || isNaN(v) ? '-' : v.toFixed(d));
const kg = x => (Math.round(x * 2) / 2).toString().replace('.', ',');
const GREEN = '#34d399', YELLOW = '#fbbf24', RED = '#f87171';

let db = store.load();
const tracker = new Tracker();
let gyro = [0, 0, 0], sensor = null, connected = false, simTimer = null, lastState = 'calib';
const S = {
  tab: 'seance', exercise: db.last.exercise, load: db.last.load,
  recording: false, reps: [], selected: null, hz: 0, rate: { n: 0, t0: 0 }, msg: ''
};

// ---------- flux de données ----------
function feed(a) {
  const reps = tracker.push(a, gyro);
  if (tracker.state !== lastState) { lastState = tracker.state; renderStatus(); }
  if (reps.length && S.recording) addReps(reps);
}

function onAcc(a) {
  const now = performance.now();
  if (!S.rate.t0) S.rate = { n: 0, t0: now };
  S.rate.n++;
  if (now - S.rate.t0 >= 3000) {                       // fréquence réelle mesurée sur 3 s
    S.hz = S.rate.n / ((now - S.rate.t0) / 1000);
    tracker.setDt(Math.abs(S.hz - 100) > 8 ? 1 / S.hz : 0.01);
    S.rate = { n: 0, t0: now };
    renderStatus();
  }
  feed(a);
}

function addReps(reps) {
  S.reps.push(...reps);
  S.selected = S.reps.length - 1;
  if (navigator.vibrate) navigator.vibrate(30);
  renderSeance();
}

// ---------- connexion ----------
async function connect() {
  if (!bleSupported()) { toast('Web Bluetooth indisponible : utilise Chrome sur Android.'); return; }
  sensor = new Sensor({
    onAcc, onGyro: g => { gyro = g; },
    onStatus: (t, ok) => { S.msg = t; connected = ok; renderStatus(); renderSeance(); },
    onDisconnect: () => { connected = false; S.msg = 'Déconnecté'; renderStatus(); renderSeance(); toast('Capteur déconnecté'); }
  });
  tracker.reset(); lastState = 'calib'; S.rate = { n: 0, t0: 0 };
  try { await sensor.connect(); toast('Connecté. Pose le capteur immobile 1 s pour le calibrage.'); }
  catch (e) { connected = false; S.msg = 'Échec : ' + e.message; renderStatus(); renderSeance(); }
}

async function disconnect() { if (sensor) await sensor.disconnect(); connected = false; renderStatus(); renderSeance(); }

// ---------- série ----------
function startSet() { S.recording = true; S.reps = []; S.selected = null; renderSeance(); }

function endSet() {
  if (S.recording) S.reps.push(...tracker.flush());
  S.recording = false;
  if (simTimer) { clearInterval(simTimer); simTimer = null; }
  if (S.reps.length) {
    db.sets.push({ id: Date.now(), t: Date.now(), exercise: S.exercise, load: S.load, reps: S.reps });
    db.last = { exercise: S.exercise, load: S.load };
    store.save(db);
    toast(`Série enregistrée : ${S.reps.length} reps à ${kg(S.load)} kg`);
  } else toast('Aucune rep détectée, série non enregistrée.');
  S.selected = S.reps.length ? S.reps.length - 1 : null;
  renderSeance();
}

function simulate() {
  if (connected) return;
  if (simTimer) clearInterval(simTimer);
  tracker.reset(); lastState = 'calib'; tracker.setDt(0.01); S.hz = 100;
  const base = Math.min(1.1, Math.max(0.28, 1.3 - S.load * 0.0095));
  const reps = [0, 1, 2, 3, 4].map(i => { const mcv = base * (1 - 0.05 * i * (S.load / 100 + 0.4)); return { mcv, dur: 0.55 / mcv }; });
  const sim = generateSet({ reps, tiltDeg: 6, swingDeg: 2, seed: Date.now() % 10000 });
  S.recording = true; S.reps = []; S.selected = null; renderSeance();
  let i = 0;
  simTimer = setInterval(() => {
    for (let k = 0; k < 10 && i < sim.acc.length; k++, i++) { gyro = sim.gyro[i]; feed(sim.acc[i]); }
    if (i >= sim.acc.length) { clearInterval(simTimer); simTimer = null; }
  }, 20);
}

// ---------- rendu ----------
function lossColor(v, best) { const l = (best - v) / best; return l <= 0.10 ? GREEN : l <= 0.20 ? YELLOW : RED; }

function statusText() {
  if (!connected) return simTimer ? 'Simulation' : (S.msg || 'Capteur non connecté');
  if (tracker.state === 'calib') return 'Calibrage... ne bouge pas';
  return (tracker.state === 'moving' ? 'Mouvement' : 'Prêt') + (S.hz ? ` · ${Math.round(S.hz)} Hz` : '');
}
function renderStatus() {
  const el = $('#chip'); if (!el) return;
  el.textContent = statusText();
  el.className = 'chip ' + (connected ? (tracker.state === 'calib' ? 'warn' : 'ok') : '');
}

function barsSvg() {
  const reps = S.reps, n = reps.length;
  if (!n) return `<div class="empty">Les reps apparaissent ici pendant la série.</div>`;
  const best = Math.max(...reps.map(r => r.mcv)), top = Math.max(1, best * 1.15);
  const W = 320, H = 150, pad = 18, bw = Math.min(44, (W - 10) / n - 8), gap = (W - n * bw) / (n + 1);
  let out = `<svg id="bars" viewBox="0 0 ${W} ${H + 22}" width="100%">`;
  reps.forEach((r, i) => {
    const h = Math.max(4, (r.mcv / top) * (H - pad)), x = gap + i * (bw + gap), y = H - h;
    const sel = i === S.selected;
    out += `<rect data-act="sel" data-i="${i}" x="${x}" y="${y}" width="${bw}" height="${h}" rx="5" fill="${lossColor(r.mcv, best)}" ${sel ? 'stroke="#fff" stroke-width="2.5"' : ''}/>`;
    out += `<text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" font-size="11" fill="#e8eaed">${fmt(r.mcv)}</text>`;
    out += `<text x="${x + bw / 2}" y="${H + 14}" text-anchor="middle" font-size="10" fill="#9aa0a6">${i + 1}</text>`;
  });
  return out + '</svg>';
}

function detailHtml() {
  const r = S.reps[S.selected];
  if (!r) return '';
  const W = 300, H = 90, max = Math.max(...r.curve, 0.1);
  const pts = r.curve.map((v, i) => `${(i / (r.curve.length - 1)) * W},${H - (Math.max(0, v) / max) * (H - 8)}`).join(' ');
  return `<div class="card">
    <div class="lbl">Rep ${S.selected + 1} · courbe de vitesse</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="margin:6px 0"><polyline points="${pts}" fill="none" stroke="${GREEN}" stroke-width="3" stroke-linejoin="round"/></svg>
    <div class="row3">
      <div class="stat"><span>Moyenne</span><b>${fmt(r.mcv)}</b><i>m/s</i></div>
      <div class="stat"><span>Pic</span><b>${fmt(r.peak)}</b><i>m/s</i></div>
      <div class="stat"><span>Durée</span><b>${fmt(r.dur, 1)}</b><i>s</i></div>
      <div class="stat"><span>Amplitude</span><b>${Math.round(r.rom * 100)}</b><i>cm</i></div>
    </div></div>`;
}

function renderSeance() {
  if (S.tab !== 'seance') return;
  const last = S.reps[S.reps.length - 1], best = S.reps.length ? Math.max(...S.reps.map(r => r.mcv)) : 0;
  const loss = last && best ? Math.round(((best - last.mcv) / best) * 100) : 0;
  $('#app').innerHTML = `
    <header><h1>VBT</h1><span id="chip" class="chip"></span></header>
    <div class="seg">${Object.entries(EXERCISES).map(([k, n]) => `<button data-act="ex" data-v="${k}" class="${k === S.exercise ? 'on' : ''}" ${S.recording ? 'disabled' : ''}>${n}</button>`).join('')}</div>
    <div class="load">
      <button data-act="load" data-v="-10" ${S.recording ? 'disabled' : ''}>-10</button>
      <button data-act="load" data-v="-2.5" ${S.recording ? 'disabled' : ''}>-2,5</button>
      <label><input id="loadIn" type="number" inputmode="decimal" step="2.5" value="${S.load}" ${S.recording ? 'disabled' : ''}><span>kg</span></label>
      <button data-act="load" data-v="2.5" ${S.recording ? 'disabled' : ''}>+2,5</button>
      <button data-act="load" data-v="10" ${S.recording ? 'disabled' : ''}>+10</button>
    </div>
    <div class="card hero">
      <div class="lbl">${last ? `Vitesse moyenne · rep ${S.reps.length}` : 'Vitesse moyenne'}</div>
      <div class="big" style="color:${last ? lossColor(last.mcv, best) : '#e8eaed'}">${last ? fmt(last.mcv) : '--'}<small>m/s</small></div>
      <div class="sub">${last ? (loss > 0 ? `−${loss}% vs meilleure rep` : 'Meilleure rep') : (S.recording ? 'Fais ta première rep' : 'Appuie sur Démarrer la série')}</div>
    </div>
    <div class="card"><div class="lbl">Reps (touche une barre pour la détailler)</div>${barsSvg()}</div>
    ${detailHtml()}
    <div class="actions">
      ${!connected && !simTimer ? `<button class="primary" data-act="connect">Connecter le capteur</button><button class="ghost" data-act="sim">Simuler une série</button>` : ''}
      ${(connected || simTimer) && !S.recording ? `<button class="primary" data-act="start">Démarrer la série</button>` : ''}
      ${S.recording ? `<button class="stop" data-act="end">Terminer la série</button>` : ''}
      ${connected && !S.recording ? `<button class="ghost" data-act="disconnect">Déconnecter</button>` : ''}
    </div>`;
  renderStatus();
}

function todaySets(ex, day) { return db.sets.filter(s => s.exercise === ex && store.dayKey(s.t) === day); }

function profileSvg(pts, fit, mvt) {
  const W = 320, H = 190, L = 38, B = 24, T = 10, R = 10;
  const loads = pts.map(p => p.load), xmax = Math.max(...loads, fit.ok ? fit.e1rm : 0) * 1.08, xmin = Math.min(...loads) * 0.8;
  const vmax = Math.max(...pts.map(p => p.v), 0.5) * 1.1, vmin = Math.min(0, mvt - 0.05);
  const X = x => L + ((x - xmin) / (xmax - xmin || 1)) * (W - L - R), Y = v => T + (1 - (v - vmin) / (vmax - vmin)) * (H - T - B);
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%">`;
  s += `<line x1="${L}" y1="${Y(mvt)}" x2="${W - R}" y2="${Y(mvt)}" stroke="#fbbf24" stroke-dasharray="4 4"/><text x="${W - R}" y="${Y(mvt) - 4}" text-anchor="end" font-size="10" fill="#fbbf24">vitesse min ${fmt(mvt)}</text>`;
  s += `<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#2a2e36"/><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#2a2e36"/>`;
  s += `<text x="4" y="${T + 8}" font-size="10" fill="#9aa0a6">m/s</text><text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="10" fill="#9aa0a6">kg</text>`;
  if (fit.ok) {
    const x1 = xmin, x2 = fit.e1rm;
    s += `<line x1="${X(x1)}" y1="${Y(fit.intercept + fit.slope * x1)}" x2="${X(x2)}" y2="${Y(mvt)}" stroke="${GREEN}" stroke-width="2"/>`;
    s += `<circle cx="${X(fit.e1rm)}" cy="${Y(mvt)}" r="6" fill="#fbbf24"/>`;
  }
  pts.forEach(p => { s += `<circle cx="${X(p.load)}" cy="${Y(p.v)}" r="5" fill="#fff"/><text x="${X(p.load)}" y="${Y(p.v) - 9}" text-anchor="middle" font-size="10" fill="#e8eaed">${fmt(p.v)}</text><text x="${X(p.load)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#9aa0a6">${kg(p.load)}</text>`; });
  return s + '</svg>';
}

function renderProfil() {
  const day = store.dayKey(Date.now()), ex = S.exercise, mvt = db.mvt[ex];
  const pts = bestPerLoad(todaySets(ex, day)), fit = fitProfile(pts, mvt);
  let body;
  if (!pts.length) body = `<div class="empty">Aucune série aujourd'hui pour ce mouvement.<br>Fais une montée en charge (3 à 4 charges, 1 à 2 reps rapides chacune) dans l'onglet Séance.</div>`;
  else {
    body = `<div class="card">${profileSvg(pts, fit, mvt)}</div>`;
    if (fit.ok) {
      const sug = [0.9, 0.75, 0.6, 0.5, 0.4].map(v => ({ v, l: loadForVelocity(fit, v) })).filter(x => x.l > 0 && x.l < fit.e1rm);
      body = `<div class="card hero"><div class="lbl">1RM estimé du jour · ${EXERCISES[ex]}</div><div class="big">${kg(fit.e1rm)}<small>kg</small></div>
        <div class="sub">${pts.length} charge(s) · R² ${fit.r2.toFixed(2)}</div></div>` + body +
        (fit.warnings.length ? `<div class="card warnbox">${fit.warnings.map(w => `<div>⚠ ${w}</div>`).join('')}</div>` : '') +
        (sug.length ? `<div class="card"><div class="lbl">Charges pour une vitesse cible</div><table>${sug.map(x => `<tr><td>${fmt(x.v)} m/s</td><td>${kg(Math.round(x.l / 2.5) * 2.5)} kg</td></tr>`).join('')}</table></div>` : '');
    } else body = `<div class="card warnbox">⚠ ${fit.reason}</div>` + body;
  }
  $('#app').innerHTML = `<header><h1>Profil</h1></header>
    <div class="seg">${Object.entries(EXERCISES).map(([k, n]) => `<button data-act="ex" data-v="${k}" class="${k === ex ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${body}
    <div class="card"><div class="lbl">Vitesse minimale (dernière rep réussie)</div>
      <div class="load" style="margin-top:6px"><label><input id="mvtIn" type="number" step="0.01" value="${mvt}"><span>m/s</span></label></div>
      <div class="sub">Valeurs de départ tirées de la littérature (squat 0,30 · bench 0,17 · deadlift 0,15). À ajuster avec tes propres échecs.</div></div>`;
}

function renderHisto() {
  const days = [...new Set(db.sets.map(s => store.dayKey(s.t)))].sort().reverse();
  let body = days.length ? '' : `<div class="empty">Pas encore de série enregistrée.</div>`;
  for (const d of days) {
    body += `<div class="day">${new Date(d + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</div>`;
    for (const ex of Object.keys(EXERCISES)) {
      const sets = todaySets(ex, d); if (!sets.length) continue;
      const fit = fitProfile(bestPerLoad(sets), db.mvt[ex]);
      body += `<div class="card"><div class="lbl">${EXERCISES[ex]}${fit.ok ? ` · 1RM du jour ≈ ${kg(fit.e1rm)} kg` : ''}</div>` +
        sets.map(s => `<div class="hrow"><div><b>${kg(s.load)} kg × ${s.reps.length}</b><span>${s.reps.map(r => fmt(r.mcv)).join(' · ')} m/s</span></div><button class="x" data-act="del" data-id="${s.id}">×</button></div>`).join('') + '</div>';
    }
  }
  $('#app').innerHTML = `<header><h1>Historique</h1></header>${body}`;
}

function render() {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === S.tab));
  ({ seance: renderSeance, profil: renderProfil, histo: renderHisto })[S.tab]();
}

let toastT;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 3500); }

// ---------- événements ----------
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, v = el.dataset.v;
  if (act === 'ex') { S.exercise = v; db.last.exercise = v; store.save(db); render(); }
  else if (act === 'load') { S.load = Math.max(0, S.load + parseFloat(v)); db.last.load = S.load; store.save(db); renderSeance(); }
  else if (act === 'sel') { S.selected = parseInt(el.dataset.i, 10); renderSeance(); }
  else if (act === 'connect') connect();
  else if (act === 'disconnect') disconnect();
  else if (act === 'start') startSet();
  else if (act === 'end') endSet();
  else if (act === 'sim') simulate();
  else if (act === 'del') { db.sets = db.sets.filter(s => String(s.id) !== el.dataset.id); store.save(db); renderHisto(); }
});
document.addEventListener('change', e => {
  if (e.target.id === 'loadIn') { S.load = Math.max(0, parseFloat(e.target.value) || 0); db.last.load = S.load; store.save(db); }
  if (e.target.id === 'mvtIn') { db.mvt[S.exercise] = Math.max(0.05, parseFloat(e.target.value) || db.mvt[S.exercise]); store.save(db); renderProfil(); }
});
$('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.tab = b.dataset.v; render(); } });

render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* hors-ligne indisponible, sans gravité */ });
