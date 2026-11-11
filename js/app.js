import { Tracker } from './signal.js';
import { Sensor, bleSupported } from './ble.js';
import { generateSet } from './sim.js';
import * as store from './store.js';
import { EXERCISES, bestPerLoad, fitProfile, loadForVelocity } from './profile.js';
import { activeReps, setStats, shouldStop, speechText, rawCsv } from './feedback.js';
import { unlockAudio, beepRep, beepStop, speak } from './audio.js';

const $ = s => document.querySelector(s);
const fmt = (v, d = 2) => (v == null || isNaN(v) ? '-' : v.toFixed(d).replace('.', ','));
const kg = x => (Math.round(x * 2) / 2).toString().replace('.', ',');

let db = store.load();
const tracker = new Tracker();
let gyro = [0, 0, 0], sensor = null, connected = false, simTimer = null, lastState = 'calib', wakeLock = null;
const S = {
  tab: 'seance', exercise: db.last.exercise, load: db.last.load,
  recording: false, reps: [], selected: null, fresh: null, hz: 0, rate: { n: 0, t0: 0 }, msg: '',
  setId: null,                       // id de la série enregistrée affichée (pour répercuter les corrections de reps)
  raw: [], pre: [], rawMeta: null    // échantillons bruts de la dernière série (export CSV) et 1,5 s qui précède
};

// ---------- écran allumé pendant la séance ----------
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (_) { /* non supporté ou refusé : sans gravité */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (connected || simTimer)) keepAwake(true); });

// ---------- flux de données ----------
function feed(a) {
  const row = [+a[0].toFixed(5), +a[1].toFixed(5), +a[2].toFixed(5), +gyro[0].toFixed(3), +gyro[1].toFixed(3), +gyro[2].toFixed(3)];
  if (S.recording) S.raw.push(row);
  else { S.pre.push(row); if (S.pre.length > 150) S.pre.shift(); }   // garde 1,5 s avant le début : permet de rejouer le calibrage
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
  S.fresh = S.reps.length - 1;
  const st = setStats(S.reps), cfg = db.settings, stop = shouldStop(S.reps, cfg.lossStop);
  if (navigator.vibrate) navigator.vibrate(stop ? [200, 100, 200, 100, 200] : 30);
  if (stop) {                                           // seuil de perte de vitesse atteint : alerte distincte d'un bip de rep
    if (cfg.sound) beepStop();
    if (cfg.voice) speak(`Arrête. Moins ${Math.round(st.loss * 100)} pour cent`);
  } else if (st.last) {
    if (cfg.sound) beepRep(zone(st.last.mcv, st.best));
    if (cfg.voice) speak(speechText(st.last.mcv));
  }
  renderSeance();
  S.fresh = null;
}

// ---------- corrections de reps (rep fantôme, rep ratée) ----------
function persistEdit() {
  if (!S.setId) return;                                 // série en cours : rien d'enregistré, S.reps suffit
  const i = db.sets.findIndex(s => s.id === S.setId);
  if (i >= 0) { if (S.reps.length) db.sets[i].reps = S.reps; else { db.sets.splice(i, 1); S.setId = null; } }
  store.save(db);
}
function toggleFailed(i) {
  const r = S.reps[i]; if (!r) return;
  if (r.failed) delete r.failed; else r.failed = true;
  persistEdit(); renderSeance();
}
function deleteRep(i) {
  if (!S.reps[i]) return;
  S.reps.splice(i, 1);
  S.selected = S.reps.length ? Math.min(i, S.reps.length - 1) : null;
  persistEdit(); renderSeance();
  toast('Rep supprimée');
}

// ---------- export ----------
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = t => new Date(t).toISOString().slice(0, 16).replace(/[:T]/g, '-');
function exportRaw() {
  const m = S.rawMeta || { exercise: S.exercise, load: S.load, t: Date.now() };
  download(`vbt_${m.exercise}_${m.load}kg_${stamp(m.t)}.csv`, rawCsv(S.raw.map((r, i) => [i, ...r]), { ...m, hz: Math.round(S.hz || 100) }), 'text/csv');
}
function exportHistory() {
  download(`vbt_historique_${stamp(Date.now())}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), sets: db.sets, mvt: db.mvt }, null, 1), 'application/json');
}

// ---------- connexion ----------
async function connect() {
  if (!bleSupported()) { toast('Web Bluetooth indisponible : utilise Chrome sur Android.'); return; }
  sensor = new Sensor({
    onAcc, onGyro: g => { gyro = g; },
    onStatus: (t, ok) => { S.msg = t; connected = ok; renderStatus(); renderSeance(); },
    onDisconnect: () => { connected = false; keepAwake(false); S.msg = 'Déconnecté'; renderStatus(); renderSeance(); toast('Capteur déconnecté'); }
  });
  tracker.reset(); lastState = 'calib'; S.rate = { n: 0, t0: 0 };
  try { await sensor.connect(); keepAwake(true); toast('Connecté. Pose le capteur immobile 1 s pour le calibrage.'); }
  catch (e) { connected = false; S.msg = 'Échec : ' + e.message; renderStatus(); renderSeance(); }
}

async function disconnect() { if (sensor) await sensor.disconnect(); connected = false; keepAwake(false); renderStatus(); renderSeance(); }

// ---------- série ----------
function startSet() {
  S.recording = true; S.reps = []; S.selected = null; S.setId = null;
  S.raw = S.pre; S.pre = []; S.rawMeta = { exercise: S.exercise, load: S.load, t: Date.now() };
  renderSeance();
}

function endSet() {
  if (S.recording) S.reps.push(...tracker.flush());
  S.recording = false;
  if (simTimer) { clearInterval(simTimer); simTimer = null; keepAwake(false); }
  S.setId = null;
  if (S.reps.length) {
    S.setId = Date.now();
    db.sets.push({ id: S.setId, t: S.setId, exercise: S.exercise, load: S.load, reps: S.reps });
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
  S.recording = true; S.reps = []; S.selected = null; S.setId = null; S.raw = []; S.pre = [];
  S.rawMeta = { exercise: S.exercise, load: S.load, t: Date.now() };
  keepAwake(true); renderSeance();
  let i = 0;
  simTimer = setInterval(() => {
    for (let k = 0; k < 10 && i < sim.acc.length; k++, i++) { gyro = sim.gyro[i]; feed(sim.acc[i]); }
    if (i >= sim.acc.length) { clearInterval(simTimer); simTimer = null; }
  }, 20);
}

// ---------- rendu ----------
const zone = (v, best) => { const l = (best - v) / best; return l <= 0.10 ? 'go' : l <= 0.20 ? 'mid' : 'stop'; };

function statusText() {
  if (!connected) return simTimer ? 'Simulation' : (S.msg || 'Capteur non connecté');
  if (tracker.state === 'calib') return 'Calibrage, ne bouge pas';
  return (tracker.state === 'moving' ? 'Mouvement' : 'Prêt') + (S.hz ? ` · ${Math.round(S.hz)} Hz` : '');
}
function renderStatus() {
  const el = $('#chip'); if (!el) return;
  el.textContent = statusText();
  el.className = 'chip ' + (connected ? (tracker.state === 'calib' ? 'warn' : 'ok') : '');
}

function barsSvg() {
  const reps = S.reps, n = reps.length;
  if (!n) return `<p class="empty">${S.recording ? 'Fais ta première rep. Elle apparaît ici dès qu\'elle est terminée.' : 'Les reps de la série s\'affichent ici.'}</p>`;
  const best = setStats(reps).best || Math.max(...reps.map(r => r.mcv)), top = Math.max(1, best * 1.12);
  const W = 320, H = 150, bw = Math.min(46, (W - 10) / n - 8), gap = (W - n * bw) / (n + 1);
  let out = `<svg id="bars" viewBox="0 0 ${W} ${H + 24}" role="img" aria-label="Vitesse moyenne de chaque rep">`;
  reps.forEach((r, i) => {
    const h = Math.max(4, (r.mcv / top) * (H - 18)), x = gap + i * (bw + gap), y = H - h;
    // rep ratée : contour pointillé et valeur barrée (jamais la couleur seule)
    const cls = r.failed ? 'failed' : `z-${zone(r.mcv, best)}`;
    out += `<rect class="bar ${cls}${i === S.selected ? ' sel' : ''}${i === S.fresh ? ' fresh' : ''}" data-act="sel" data-i="${i}" x="${x}" y="${y}" width="${bw}" height="${h}"/>`;
    out += `<text class="bv${r.failed ? ' fail' : ''}" x="${x + bw / 2}" y="${y - 6}">${fmt(r.mcv)}</text><text class="bn" x="${x + bw / 2}" y="${H + 16}">${i + 1}</text>`;
  });
  return out + `<line class="base" x1="0" y1="${H}" x2="${W}" y2="${H}"/></svg>`;
}

function detailHtml() {
  const r = S.reps[S.selected];
  if (!r) return '';
  const W = 300, H = 80, max = Math.max(...r.curve, 0.1);
  const pts = r.curve.map((v, i) => `${(i / (r.curve.length - 1)) * W},${H - 4 - (Math.max(0, v) / max) * (H - 12)}`).join(' ');
  return `<section class="detail">
    <h2 class="cap">Rep ${S.selected + 1}${r.failed ? ' · ratée, non comptée' : ''} · courbe de vitesse</h2>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Courbe de vitesse de la rep"><polyline class="curve" points="${pts}"/></svg>
    <dl class="facts">
      <div><dt>Moyenne</dt><dd>${fmt(r.mcv)}<small>m/s</small></dd></div>
      <div><dt>Pic</dt><dd>${fmt(r.peak)}<small>m/s</small></dd></div>
      <div><dt>Durée</dt><dd>${fmt(r.dur, 1)}<small>s</small></dd></div>
      <div><dt>Amplitude</dt><dd>${Math.round(r.rom * 100)}<small>cm</small></dd></div>
    </dl>
    <div class="repedit">
      <button class="btn alt sm" data-act="fail">${r.failed ? 'Rep valide' : 'Rep ratée'}</button>
      <button class="btn alt sm" data-act="delrep">Supprimer</button>
    </div></section>`;
}

function renderSeance() {
  if (S.tab !== 'seance') return;
  const st = setStats(S.reps), last = st.last, best = st.best, cfg = db.settings;
  const loss = Math.round(st.loss * 100), stop = shouldStop(S.reps, cfg.lossStop);
  const lastNo = last ? S.reps.lastIndexOf(last) + 1 : 0;
  const seg = (act, items, isOn) => items.map(([v, l]) => `<button data-act="${act}" data-v="${v}" class="${isOn(v) ? 'on' : ''}" aria-pressed="${isOn(v)}">${l}</button>`).join('');
  const setup = S.recording ? '' : `
    <section class="opts" aria-label="Retour pendant la série">
      <div class="optrow"><span class="cap" id="lossLbl">Alerte d'arrêt</span><div class="seg" role="group" aria-labelledby="lossLbl">${seg('loss', [[0, 'Off'], [0.1, '10 %'], [0.2, '20 %'], [0.3, '30 %']], v => cfg.lossStop === v)}</div></div>
      <div class="optrow"><span class="cap" id="fbLbl">Retour</span><div class="seg" role="group" aria-labelledby="fbLbl">${seg('tog', [['sound', 'Son'], ['voice', 'Voix']], v => cfg[v])}</div></div>
    </section>
    <div class="ex" role="group" aria-label="Mouvement">${Object.entries(EXERCISES).map(([k, n]) => `<button data-act="ex" data-v="${k}" class="${k === S.exercise ? 'on' : ''}" aria-pressed="${k === S.exercise}">${n}</button>`).join('')}</div>
    <div class="stepper">
      <button data-act="load" data-v="-10" aria-label="Moins 10 kilos">−10</button>
      <button data-act="load" data-v="-2.5" aria-label="Moins 2,5 kilos">−2,5</button>
      <label><input id="loadIn" type="number" inputmode="decimal" step="2.5" value="${S.load}" aria-label="Charge en kilos"><span>kg</span></label>
      <button data-act="load" data-v="2.5" aria-label="Plus 2,5 kilos">+2,5</button>
      <button data-act="load" data-v="10" aria-label="Plus 10 kilos">+10</button>
    </div>`;
  const dz = last ? `z-${zone(last.mcv, best)}` : "";
  const delta = (last ? (loss > 0 ? `<p class="delta ${dz}">−${loss} % par rapport à ta meilleure rep</p>` : `<p class="delta ${dz}">Meilleure rep de la série</p>`)
    : `<p class="delta quiet">${S.recording ? 'En attente de la première rep' : 'Règle la charge, puis démarre la série.'}</p>`)
    + (stop ? `<p class="stopbar" role="alert">Perte de ${loss} % : arrête la série</p>` : '');
  $('#app').innerHTML = `
    <header class="top"><span id="chip" class="chip"></span>${S.recording ? `<span class="ctx">${EXERCISES[S.exercise]} · ${kg(S.load)} kg</span>` : ''}</header>
    ${setup}
    <section class="reading" aria-live="polite">
      <p class="cap">${last ? `Rep ${lastNo} · vitesse moyenne` : 'Vitesse moyenne'}</p>
      <p class="num${last ? '' : ' none'}">${last ? fmt(last.mcv) : '0,00'}<span class="unit">m/s</span></p>
      ${delta}
    </section>
    <section class="reps"><h2 class="cap">Reps${S.reps.length ? ' · touche une barre pour le détail' : ''}</h2>${barsSvg()}</section>
    ${detailHtml()}
    <div class="actions${S.recording ? ' sticky' : ''}">
      ${!connected && !simTimer ? `<button class="btn" data-act="connect">Connecter le capteur</button><button class="btn alt" data-act="sim">Simuler une série</button>` : ''}
      ${(connected || simTimer) && !S.recording ? `<button class="btn" data-act="start">Démarrer la série</button>` : ''}
      ${S.recording ? `<button class="btn" data-act="end">Terminer la série</button>` : ''}
      ${!S.recording && S.raw.length > 50 ? `<button class="btn alt" data-act="exportraw">Exporter les données brutes (CSV)</button>` : ''}
      ${connected && !S.recording ? `<button class="btn alt" data-act="disconnect">Déconnecter</button>` : ''}
    </div>`;
  renderStatus();
}

function todaySets(ex, day) { return db.sets.filter(s => s.exercise === ex && store.dayKey(s.t) === day); }

function profileSvg(pts, fit, mvt) {
  const W = 320, H = 200, L = 6, B = 40, T = 14, R = 10;
  const loads = pts.map(p => p.load), xmax = Math.max(...loads, fit.ok ? fit.e1rm : 0) * 1.06, xmin = Math.min(...loads) * 0.8;
  const vmax = Math.max(...pts.map(p => p.v), 0.5) * 1.12, vmin = Math.min(0, mvt - 0.05);
  const X = x => L + ((x - xmin) / (xmax - xmin || 1)) * (W - L - R), Y = v => T + (1 - (v - vmin) / (vmax - vmin)) * (H - T - B);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Profil charge-vitesse">`;
  s += `<line class="base" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>`;
  s += `<line x1="${L}" y1="${Y(mvt)}" x2="${W - R}" y2="${Y(mvt)}" stroke="oklch(52% 0.015 255)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  s += `<text x="${L}" y="${Y(mvt) - 6}" font-size="11" font-weight="600" fill="oklch(52% 0.015 255)">vitesse minimale ${fmt(mvt)} m/s</text>`;
  if (fit.ok) {
    s += `<line x1="${X(xmin)}" y1="${Y(fit.intercept + fit.slope * xmin)}" x2="${X(fit.e1rm)}" y2="${Y(mvt)}" stroke="oklch(21% 0.02 255)" stroke-width="2.5"/>`;
    s += `<circle cx="${X(fit.e1rm)}" cy="${Y(mvt)}" r="8" fill="oklch(97.5% 0.007 95)" stroke="oklch(21% 0.02 255)" stroke-width="3"/>`;
    s += `<text x="${X(fit.e1rm)}" y="${Y(mvt) + 26}" text-anchor="middle" font-size="12" font-weight="700" fill="oklch(21% 0.02 255)">1RM ${kg(fit.e1rm)}</text>`;
  }
  pts.forEach(p => { s += `<circle cx="${X(p.load)}" cy="${Y(p.v)}" r="6" fill="oklch(21% 0.02 255)"/><text class="bv" x="${X(p.load)}" y="${Y(p.v) - 12}">${fmt(p.v)}</text><text class="bn" x="${X(p.load)}" y="${H - B + 16}">${kg(p.load)} kg</text>`; });
  return s + '</svg>';
}

function renderProfil() {
  const day = store.dayKey(Date.now()), ex = S.exercise, mvt = db.mvt[ex];
  const pts = bestPerLoad(todaySets(ex, day)), fit = fitProfile(pts, mvt);
  let body;
  if (!pts.length) body = `<p class="empty">Aucune série aujourd'hui pour ce mouvement. Fais une montée en charge dans l'onglet Séance : 3 ou 4 charges, 1 ou 2 reps rapides chacune.</p>`;
  else {
    const sug = fit.ok ? [0.9, 0.75, 0.6, 0.5, 0.4].map(v => ({ v, l: loadForVelocity(fit, v) })).filter(x => x.l > 0 && x.l < fit.e1rm) : [];
    body = (fit.ok ? `<section class="reading"><p class="cap">1RM estimé du jour · ${EXERCISES[ex]}</p><p class="num">${kg(fit.e1rm)}<span class="unit">kg</span></p><p class="delta quiet">${pts.length} charge${pts.length > 1 ? 's' : ''} · R² ${fmt(fit.r2)}</p></section>` : `<p class="note"><strong>Pas d'estimation.</strong> ${fit.reason}</p>`) +
      `<section class="block"><h2 class="cap">Charge et vitesse</h2>${profileSvg(pts, fit, mvt)}</section>` +
      (fit.ok && fit.warnings.length ? fit.warnings.map(w => `<p class="note"><strong>Attention.</strong> ${w}</p>`).join('') : '') +
      (sug.length ? `<section class="block"><h2 class="cap">Charge pour une vitesse cible</h2><table>${sug.map(x => `<tr><td>${fmt(x.v)} m/s</td><td>${kg(Math.round(x.l / 2.5) * 2.5)} kg</td></tr>`).join('')}</table></section>` : '');
  }
  $('#app').innerHTML = `<header class="top"><h1>Profil</h1></header>
    <div class="ex" role="group" aria-label="Mouvement">${Object.entries(EXERCISES).map(([k, n]) => `<button data-act="ex" data-v="${k}" class="${k === ex ? 'on' : ''}" aria-pressed="${k === ex}">${n}</button>`).join('')}</div>
    ${body}
    <section class="block"><div class="setting"><label class="cap" for="mvtIn">Vitesse minimale<br>(dernière rep réussie)</label><input id="mvtIn" type="number" step="0.01" inputmode="decimal" value="${mvt}"></div>
      <p class="hint" style="margin-top:8px">Valeurs de départ tirées de la littérature : squat 0,30 · bench 0,17 · deadlift 0,15 m/s. À ajuster avec tes propres échecs.</p></section>`;
}

function renderHisto() {
  const days = [...new Set(db.sets.map(s => store.dayKey(s.t)))].sort().reverse();
  let body = days.length ? '' : `<p class="empty">Pas encore de série enregistrée. Elles apparaissent ici dès que tu termines une série.</p>`;
  for (const d of days) {
    body += `<h2 class="day">${new Date(d + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>`;
    for (const ex of Object.keys(EXERCISES)) {
      const sets = todaySets(ex, d); if (!sets.length) continue;
      const fit = fitProfile(bestPerLoad(sets), db.mvt[ex]);
      body += `<section class="block"><h3 class="cap" style="margin:0">${EXERCISES[ex]}${fit.ok ? ` · 1RM du jour ≈ ${kg(fit.e1rm)} kg` : ''}</h3>` +
        sets.map(s => `<div class="hrow"><div><b>${kg(s.load)} kg × ${activeReps(s.reps).length}${s.reps.some(r => r.failed) ? ' · ratée' : ''}</b><span>${s.reps.map(r => r.failed ? `<s>${fmt(r.mcv)}</s>` : fmt(r.mcv)).join(' · ')} m/s</span></div><button class="x" data-act="del" data-id="${s.id}" aria-label="Supprimer cette série">×</button></div>`).join('') + '</section>';
    }
  }
  $('#app').innerHTML = `<header class="top"><h1>Historique</h1></header>${body}` +
    (db.sets.length ? `<button class="btn alt" data-act="exporthist">Exporter l'historique (JSON)</button>` : '');
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
  unlockAudio();                                      // Chrome n'autorise le son qu'après un toucher
  if (act === 'loss') { db.settings.lossStop = parseFloat(v); store.save(db); renderSeance(); }
  else if (act === 'tog') { db.settings[v] = !db.settings[v]; store.save(db); if (db.settings[v] && v === 'voice') speak('Voix activée'); renderSeance(); }
  else if (act === 'fail') toggleFailed(S.selected);
  else if (act === 'delrep') deleteRep(S.selected);
  else if (act === 'exportraw') exportRaw();
  else if (act === 'exporthist') exportHistory();
  else if (act === 'ex') { S.exercise = v; db.last.exercise = v; store.save(db); render(); }
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
