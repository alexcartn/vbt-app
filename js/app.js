import { Tracker } from './signal.js';
import { Sensor, bleSupported } from './ble.js';
import { PhoneSensor, phoneSupported } from './phone.js';
import { generateSet } from './sim.js';
import * as store from './store.js';
import { EXERCISES, MVT_DEFAULT, bestPerLoad, fitProfile, loadForVelocity, mvtNote } from './profile.js';
import { activeReps, setStats, shouldStop, rawCsv, restDisplay, targetDelta } from './feedback.js';
import { sessions, progress, loadsUsed, setSummary, repMaxes, repCount } from './history.js';
import { unlockAudio, beepRep, beepStop, beepReady } from './audio.js';

const $ = s => document.querySelector(s);
const fmt = (v, d = 2) => (v == null || isNaN(v) ? '-' : v.toFixed(d).replace('.', ','));
const kg = x => (Math.round(x * 2) / 2).toString().replace('.', ',');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dateLong = d => new Date(d + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const dateShort = d => `${d.slice(8)}/${d.slice(5, 7)}`;

let db = store.load();
if (store.isDemo) {
  document.body.classList.add('demo');
  const bar = document.createElement('div');
  bar.id = 'demoBar';
  bar.innerHTML = `<span>Démo : données d'exemple, rien n'est enregistré dans ton vrai historique.</span><a class="link" href="${location.pathname}">Quitter</a>`;
  document.body.insertBefore(bar, document.getElementById('app'));
}
const prof = () => db.profiles.find(p => p.id === db.activeProfile);
const tracker = new Tracker();
let gyro = [0, 0, 0], sensor = null, connected = false, simTimer = null, lastState = 'calib', wakeLock = null;
const S = {
  tab: 'seance', exercise: db.last.exercise, load: db.last.load, target: db.last.target ?? null,   // target : vitesse cible (m/s) ou null
  recording: false, reps: [], selected: null, fresh: null, hz: 0, rate: { n: 0, t0: 0 }, msg: '',
  h: { view: 'list', ex: 'all', limit: 4, setId: null, sel: null },                   // onglet Historique : chronologie des séances
  st: { ex: db.last.exercise, metric: 'e1rm', load: null },                           // onglet Stats : évolution, estimations
  restEnd: null,                     // minuteur de repos : instant (ms) où le repos est terminé
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
  } else if (st.last) {
    if (cfg.sound) beepRep(zone(st.last.mcv, st.best));
  }
  renderSeance();
  S.fresh = null;
}

// ---------- minuteur de repos (facultatif) ----------
let restTimer = null, restBeeped = false;
function restTick() {
  if (!S.restEnd) return;
  const d = restDisplay(S.restEnd - Date.now());
  if (d.over && !restBeeped) {                          // repos terminé : un seul signal
    restBeeped = true;
    if (db.settings.sound) beepReady();
    if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
  }
  const t = $('#restTime'), box = $('#restBox'), cap = $('#restCap');
  if (t) t.textContent = d.text;
  if (cap) cap.textContent = d.over ? 'Repos terminé' : 'Repos';
  if (box) box.classList.toggle('over', d.over);
}
function startRest() {
  stopRest();
  const sec = db.settings.rest;
  if (!(sec > 0)) return;
  S.restEnd = Date.now() + sec * 1000; restBeeped = false;
  restTimer = setInterval(restTick, 500);
}
function stopRest() {
  clearInterval(restTimer); restTimer = null; S.restEnd = null; restBeeped = false;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') restTick(); });
const restHtml = () => {
  if (!S.restEnd || S.recording) return '';
  const d = restDisplay(S.restEnd - Date.now());
  return `<section id="restBox" class="rest${d.over ? ' over' : ''}" role="timer" aria-label="Minuteur de repos"><div><p class="cap" id="restCap">${d.over ? 'Repos terminé' : 'Repos'}</p><p class="stat" id="restTime">${d.text}</p></div><button class="btn alt sm" data-act="restskip">Passer</button></section>`;
};

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

// ---------- série sans capteur ----------
function addManualSet() {
  const n = parseInt(prompt('Nombre de reps de cette série (sans capteur)', '5'), 10);
  if (!(n >= 1 && n <= 100)) return;
  const t = Date.now();
  db.sets.push({ id: t, t, exercise: S.exercise, load: S.load, profileId: db.activeProfile, manual: true, count: n, reps: [] });
  db.last = { exercise: S.exercise, load: S.load, target: S.target };
  store.save(db);
  toast(`Série sans capteur ajoutée : ${n} reps à ${kg(S.load)} kg`);
}

// ---------- vitesse minimale individuelle : la vitesse de ta dernière rep réussie à l'échec ----------
function setMvtFromRep(rep, profileId, exercise) {
  const p = db.profiles.find(x => x.id === profileId);
  if (!rep || !p || rep.failed) { toast('Choisis une rep réussie.'); return; }
  if (!confirm(`Définir ${fmt(rep.mcv)} m/s comme vitesse minimale de ${p.name} en ${EXERCISES[exercise].toLowerCase()} ? Cela change son 1RM estimé.`)) return;
  p.mvt[exercise] = Math.max(0.05, rep.mcv); p.mvtCustom[exercise] = true;
  store.save(db);
  toast(`Vitesse minimale de ${p.name} : ${fmt(rep.mcv)} m/s`);
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
  download(`vbt_historique_${stamp(Date.now())}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), profiles: db.profiles, sets: db.sets }, null, 1), 'application/json');
}

// ---------- connexion ----------
async function connect(kind = 'ble') {
  const phone = kind === 'phone';
  if (phone ? !phoneSupported() : !bleSupported()) { toast(phone ? 'Capteurs du téléphone indisponibles sur ce navigateur.' : 'Web Bluetooth indisponible : utilise Chrome sur Android.'); return; }
  sensor = new (phone ? PhoneSensor : Sensor)({
    onAcc, onGyro: g => { gyro = g; },
    onStatus: (t, ok) => { S.msg = t; connected = ok; renderStatus(); renderSeance(); },
    onDisconnect: () => { connected = false; keepAwake(false); S.msg = 'Déconnecté'; renderStatus(); renderSeance(); toast('Capteur déconnecté'); }
  });
  tracker.reset(); lastState = 'calib'; S.rate = { n: 0, t0: 0 }; S.hz = 0;
  tracker.setDt(phone ? 1 / 60 : 0.01);               // le téléphone échantillonne à ~60 Hz ; la fréquence réelle est mesurée ensuite
  try { await sensor.connect(); keepAwake(true); toast(phone ? 'Téléphone prêt. Pose-le immobile sur la barre 1 s pour le calibrage.' : 'Connecté. Pose le capteur immobile 1 s pour le calibrage.'); }
  catch (e) { connected = false; S.msg = 'Échec : ' + e.message; renderStatus(); renderSeance(); }
}

async function disconnect() { if (sensor) await sensor.disconnect(); connected = false; keepAwake(false); renderStatus(); renderSeance(); }

// ---------- série ----------
function startSet() {
  stopRest();
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
    db.sets.push({ id: S.setId, t: S.setId, exercise: S.exercise, load: S.load, profileId: db.activeProfile, ...(S.target ? { target: S.target } : {}), reps: S.reps });
    db.last = { exercise: S.exercise, load: S.load, target: S.target };
    store.save(db);
    toast(`Série de ${prof().name} enregistrée : ${S.reps.length} reps à ${kg(S.load)} kg`);
    startRest();
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
  stopRest();
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

function barsSvg(reps = S.reps, selected = S.selected, fresh = S.fresh, act = 'sel', target = S.target) {
  const n = reps.length;
  if (!n) return `<p class="empty">${S.recording ? 'Fais ta première rep. Elle apparaît ici dès qu\'elle est terminée.' : 'Les reps de la série s\'affichent ici.'}</p>`;
  const best = setStats(reps).best || Math.max(...reps.map(r => r.mcv)), top = Math.max(0.6, best * 1.15, (target || 0) * 1.1);
  const W = 320, H = 150, bw = Math.min(46, (W - 10) / n - 8), gap = (W - n * bw) / (n + 1);
  let out = `<svg id="bars" viewBox="0 0 ${W} ${H + 24}" role="img" aria-label="Vitesse moyenne de chaque rep">`;
  reps.forEach((r, i) => {
    const h = Math.max(4, (r.mcv / top) * (H - 18)), x = gap + i * (bw + gap), y = H - h;
    // rep ratée : contour pointillé et valeur barrée (jamais la couleur seule)
    const cls = r.failed ? 'failed' : `z-${zone(r.mcv, best)}`;
    out += `<rect class="bar ${cls}${i === selected ? ' sel' : ''}${i === fresh ? ' fresh' : ''}" data-act="${act}" data-i="${i}" x="${x}" y="${y}" width="${bw}" height="${h}"/>`;
    out += `<text class="bv${r.failed ? ' fail' : ''}" x="${x + bw / 2}" y="${y - 6}">${fmt(r.mcv)}</text><text class="bn" x="${x + bw / 2}" y="${H + 16}">${i + 1}</text>`;
  });
  if (target) { const y = H - (target / top) * (H - 18); out += `<line class="tline" x1="0" y1="${y}" x2="${W}" y2="${y}"/><text class="tlab" x="${W}" y="${y - 4}">cible ${fmt(target)}</text>`; }
  return out + `<line class="base" x1="0" y1="${H}" x2="${W}" y2="${H}"/></svg>`;
}

function detailHtml(reps = S.reps, selected = S.selected, acts = ['fail', 'delrep', 'setmvt']) {
  const r = reps[selected];
  if (!r) return '';
  const best = setStats(reps).best, gap = best ? Math.round(((best - r.mcv) / best) * 100) : 0;
  const W = 300, H = 80, max = Math.max(...r.curve, 0.1);
  const pts = r.curve.map((v, i) => `${(i / (r.curve.length - 1)) * W},${H - 4 - (Math.max(0, v) / max) * (H - 12)}`).join(' ');
  return `<section class="detail">
    <h2 class="cap">Rep ${selected + 1}${r.failed ? ' · ratée, non comptée' : ''} · courbe de vitesse</h2>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Courbe de vitesse de la rep"><polyline class="curve" points="${pts}"/></svg>
    <dl class="facts">
      <div><dt>Moyenne</dt><dd>${fmt(r.mcv)}<small>m/s</small></dd></div>
      <div><dt>Pic</dt><dd>${fmt(r.peak)}<small>m/s</small></dd></div>
      <div><dt>Durée</dt><dd>${fmt(r.dur, 1)}<small>s</small></dd></div>
      ${db.settings.showRom ? `<div><dt>Amplitude</dt><dd>${Math.round(r.rom * 100)}<small>cm</small></dd></div>` : `<div><dt>Écart</dt><dd>${gap > 0 ? '−' : ''}${gap}<small>%</small></dd></div>`}
    </dl>
    ${db.settings.showRom ? '<p class="hint">Amplitude non validée : à vérifier au mètre.</p>' : ''}
    <div class="repedit">
      <button class="btn alt sm" data-act="${acts[0]}">${r.failed ? 'Rep valide' : 'Rep ratée'}</button>
      <button class="btn alt sm" data-act="${acts[1]}">Supprimer</button>
      <button class="btn alt sm wide" data-act="${acts[2]}">Définir comme vitesse minimale</button>
    </div></section>`;
}

function renderSeance() {
  if (S.tab !== 'seance') return;
  const st = setStats(S.reps), last = st.last, best = st.best, cfg = db.settings;
  const loss = Math.round(st.loss * 100), stop = shouldStop(S.reps, cfg.lossStop);
  const lastNo = last ? S.reps.lastIndexOf(last) + 1 : 0;
  const seg = (act, items, isOn) => items.map(([v, l]) => `<button data-act="${act}" data-v="${v}" class="${isOn(v) ? 'on' : ''}" aria-pressed="${isOn(v)}">${l}</button>`).join('');
  const optsSum = [cfg.lossStop && `Alerte ${Math.round(cfg.lossStop * 100)} %`, cfg.rest && `Repos ${cfg.rest / 60} min`, S.target && `Cible ${fmt(S.target)}`, cfg.sound && 'Son'].filter(Boolean).join(' · ') || 'Aucun';
  const setup = S.recording ? '' : `
    <div class="ex" role="group" aria-label="Mouvement">${Object.entries(EXERCISES).map(([k, n]) => `<button data-act="ex" data-v="${k}" class="${k === S.exercise ? 'on' : ''}" aria-pressed="${k === S.exercise}">${n}</button>`).join('')}</div>
    <div class="stepper">
      <button data-act="load" data-v="-10" aria-label="Moins 10 kilos">−10</button>
      <button data-act="load" data-v="-2.5" aria-label="Moins 2,5 kilos">−2,5</button>
      <label><input id="loadIn" type="number" inputmode="decimal" step="2.5" value="${S.load}" aria-label="Charge en kilos"><span>kg</span></label>
      <button data-act="load" data-v="2.5" aria-label="Plus 2,5 kilos">+2,5</button>
      <button data-act="load" data-v="10" aria-label="Plus 10 kilos">+10</button>
    </div>
    <details class="opts" id="optsBox"${S.optsOpen ? ' open' : ''}>
      <summary><span class="cap">Réglages</span><span class="sum">${optsSum}</span></summary>
      <div class="optlist">
      <div class="optrow"><span class="cap" id="lossLbl">Alerte d'arrêt</span><div class="seg" role="group" aria-labelledby="lossLbl">${seg('loss', [[0, 'Off'], [0.1, '10 %'], [0.2, '20 %'], [0.3, '30 %']], v => cfg.lossStop === v)}</div></div>
      <div class="optrow"><span class="cap" id="restLbl">Repos</span><div class="seg" role="group" aria-labelledby="restLbl">${seg('rest', [[0, 'Off'], [120, '2 min'], [180, '3 min'], [300, '5 min']], v => cfg.rest === v)}</div></div>
      <div class="optrow"><span class="cap" id="tgtLbl">Vitesse cible</span><div class="tstep" role="group" aria-labelledby="tgtLbl"><button data-act="tgt" data-v="-0.05" aria-label="Cible moins 0,05">−</button><output>${S.target ? `${fmt(S.target)} m/s` : 'Off'}</output><button data-act="tgt" data-v="0.05" aria-label="Cible plus 0,05">+</button></div></div>
      <div class="optrow"><span class="cap" id="fbLbl">Retour</span><div class="seg" role="group" aria-labelledby="fbLbl">${seg('tog', [['sound', 'Son']], v => cfg[v])}</div></div>
      <div class="optrow"><span class="cap" id="romLbl">Test de mesure</span><div class="seg" role="group" aria-labelledby="romLbl">${seg('tog', [['showRom', 'Amplitude']], v => cfg[v])}</div></div>
      </div>
    </details>`;
  const dz = last ? `z-${zone(last.mcv, best)}` : "";
  const delta = (last ? (loss > 0 ? `<p class="delta ${dz}">−${loss} % par rapport à ta meilleure rep</p>` : `<p class="delta ${dz}">Meilleure rep de la série</p>`)
    : `<p class="delta quiet">${S.recording ? 'En attente de la première rep' : 'Règle la charge, puis démarre la série.'}</p>`)
    + (last && S.target ? (td => `<p class="delta">Cible ${fmt(S.target)} m/s : ${td.text} ${td.met ? '(atteinte)' : '(non atteinte)'}</p>`)(targetDelta(last.mcv, S.target)) : '')
    + (stop ? `<p class="stopbar" role="alert">Perte de ${loss} % : arrête la série</p>` : '');
  const dock = S.recording ? `<button class="btn" data-act="end">Terminer la série</button>`
    : (connected || simTimer) ? `<button class="btn" data-act="start">Démarrer la série</button>` : '';
  const actions = `
    <div class="actions">
      ${!connected && !simTimer ? `<div class="connect${bleSupported() ? '' : ' solo'}"><button class="btn sm" data-act="connect-phone">Utiliser le téléphone</button>${bleSupported() ? '<button class="btn sm alt" data-act="connect">MetaMotion</button>' : ''}</div>
        <button class="btn sm ghost" data-act="sim">Essayer avec une série simulée</button>` : ''}
      <details class="more" id="moreBox"${S.moreOpen ? ' open' : ''}><summary class="cap">Autres actions</summary>
        <button class="btn alt" data-act="manual">Série sans capteur</button>
        ${S.raw.length > 50 ? `<button class="btn alt" data-act="exportraw">Exporter les données brutes (CSV)</button>` : ''}
        ${connected ? `<button class="btn alt" data-act="disconnect">Déconnecter</button>` : ''}
      </details>
    </div>`;
  $('#app').innerHTML = `
    <header class="top"><span id="chip" class="chip"></span>${S.recording ? `<span class="ctx">${esc(prof().name)} · ${EXERCISES[S.exercise]} · ${kg(S.load)} kg</span>` : whoBar()}</header>
    ${restHtml()}
    ${S.recording ? '' : envNotice()}
    ${S.recording || cfg.guideSeen ? '' : `<section class="intro"><p><b>Première fois ?</b> Le guide explique en 1 minute comment fixer le téléphone, lire les résultats et régler l'app.</p><div class="introbtn"><button class="btn sm" data-act="guide">Ouvrir le guide</button><button class="btn sm alt" data-act="guidehide">Plus tard</button></div></section>`}
    ${setup}
    ${S.recording ? '' : actions}
    <section class="reading" aria-live="polite">
      <p class="cap">${last ? `Rep ${lastNo} · vitesse moyenne` : 'Vitesse moyenne'}</p>
      <p class="num${last ? '' : ' none'}">${last ? fmt(last.mcv) : '0,00'}<span class="unit">m/s</span></p>
      ${delta}
    </section>
    <section class="reps"><h2 class="cap">Reps${S.reps.length ? ' · touche une barre pour le détail' : ''}</h2>${barsSvg()}</section>
    ${detailHtml()}
    ${dock ? `<div class="dock">${dock}</div>` : ''}`;
  document.body.classList.toggle('has-dock', !!dock);
  renderStatus();
}



// ---------- environnement : navigateur intégré, iPhone, retours ----------
const UA = navigator.userAgent;
const isIOS = /iP(hone|ad|od)/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const inApp = /LinkedInApp|FBAN|FBAV|Instagram|Twitter|MicroMessenger|Snapchat|; wv\)/.test(UA) || (isIOS && !/Safari/.test(UA));   // navigateur intégré à une appli : capteurs souvent bloqués
const ISSUES = 'https://github.com/alexcartn/vbt-app/issues/new';
function feedbackUrl() {
  const body = `Ce qui s'est passé :\n\n\nAttendu :\n\n\n---\nAppareil et navigateur : ${UA}\nCapteur : ${sensor && sensor.api ? sensor.api : (connected ? 'MetaMotion' : 'non connecté')}\nFréquence mesurée : ${S.hz ? Math.round(S.hz) + ' Hz' : 'inconnue'}\n`;
  return `${ISSUES}?title=${encodeURIComponent('Retour : ')}&body=${encodeURIComponent(body)}`;
}
const feedbackLink = label => `<a class="link" href="${feedbackUrl()}" target="_blank" rel="noopener">${label}</a>`;
function envNotice() {
  if (inApp) return `<section class="notice" role="alert"><p><b>Ouvre cette page dans Chrome ou Safari.</b> Tu es dans le navigateur d'une application : les capteurs de mouvement y sont souvent bloqués et l'app ne pourra pas mesurer.</p><button class="btn sm alt" data-act="copylink">Copier le lien</button></section>`;
  if (isIOS) return `<section class="notice"><p><b>iPhone : mode expérimental.</b> Cette version n'a pas encore été testée sur iPhone : les vitesses peuvent être fausses sans que l'app le détecte. Ne t'y fie pas avant d'avoir comparé avec ton ressenti. ${feedbackLink('Dis-nous ce que tu observes')}</p></section>`;
  if (!phoneSupported()) return `<section class="notice"><p>Ce navigateur n'a pas accès aux capteurs de mouvement. Ouvre la page sur ton téléphone (Chrome sur Android), ou essaie l'app avec « Simuler une série » dans « Plus ».</p></section>`;
  return '';
}
const DISCLAIMER = `<p class="hint">Outil expérimental et indicatif, non validé sur barre réelle. Il ne remplace ni un entraîneur ni un avis médical : ne l'utilise pas pour décider d'une charge maximale, et fixe le téléphone de façon sûre.</p>`;

// ---------- guide ----------
function renderGuide() {
  const sec = (t, body) => `<section class="guide"><h2 class="cap">${t}</h2>${body}</section>`;
  const link = db.settings.guideSeen ? `<button class="back" data-act="guideback">← Retour</button>` : '';
  $('#app').innerHTML = `
    ${link}
    <header class="top"><h1>Guide</h1></header>
    <p class="hint">Quelques minutes de lecture. Le bouton « ? » en haut de chaque écran te ramène ici.</p>
    ${sec('Démarrer en 5 gestes', `<ol>
      <li>Choisis le mouvement et la charge sur la barre.</li>
      <li>Touche « Utiliser le téléphone » (autorise les capteurs de mouvement si Chrome le demande).</li>
      <li>Fixe le téléphone sur la barre, puis garde-le immobile 1 s : l'app se calibre toute seule, dans n'importe quelle position.</li>
      <li>Touche « Démarrer la série », puis fais tes reps. Chaque rep s'affiche et fait un bip dès qu'elle est terminée.</li>
      <li>Touche « Terminer la série » : elle est enregistrée dans l'historique.</li>
    </ol>`)}
    ${sec('Faire tes reps', `<ul>
      <li>Intention maximale : pousse chaque rep le plus vite possible, même avec une charge lourde qui part lentement. C'est l'intention d'aller vite qui rend les mesures comparables, pas la vitesse atteinte.</li>
      <li>Descente contrôlée et régulière, sans rebond, puis montée explosive. L'app mesure la vitesse moyenne de la montée.</li>
      <li>Même technique, même amplitude et même position du téléphone à chaque rep et d'une séance à l'autre. Sans ça, comparer les chiffres n'a pas de sens.</li>
      <li>Marque une courte pause entre les reps (en bas ou en haut) : le capteur se recale à chaque arrêt. Enchaîner sans pause reste possible, mais moins précis.</li>
      <li>En série de travail, arrête-toi quand la perte de vitesse atteint ton seuil (l'alerte d'arrêt). 10 à 20 % suffisent souvent pour la force.</li>
    </ul>`)}
    ${sec('Faire ton 1RM du jour', `<ul>
      <li>Échauffe-toi, puis monte en 3 à 5 charges, d'une charge légère (environ 40 à 50 % de ton max) jusqu'à une charge lourde (85 à 90 %).</li>
      <li>2 à 3 reps aux charges légères, 1 à 2 aux charges lourdes, jamais jusqu'à l'échec.</li>
      <li>2 à 3 minutes de repos entre les charges lourdes.</li>
      <li>L'app garde la rep la plus rapide de chaque charge, trace la droite charge-vitesse et en déduit ton 1RM du jour. Il peut varier avec ta forme (fatigue, sommeil).</li>
      <li>Le 1RM estimé sert à doser la charge du jour, ce n'est pas un poids à tenter, surtout au deadlift.</li>
    </ul>`)}
    ${sec('Fixer le téléphone sur la barre', `<ul>
      <li>Sécurité d'abord : support rigide, serré, qui ne peut pas glisser ni tomber. Au développé couché, ne le place jamais au-dessus du visage sans attache solide.</li>
      <li>Fixe-le sur la partie fixe de la barre. Le manchon où l'on met les disques tourne souvent librement : évite-le.</li>
      <li>L'orientation n'a pas d'importance, mais il ne doit pas bouger par rapport à la barre pendant la série.</li>
      <li>Garde l'écran allumé (l'app le demande) et désactive l'économiseur de batterie.</li>
      <li>Le téléphone n'est plus visible sur la barre : active le son, ou pose un second appareil devant toi.</li>
    </ul>`)}
    ${sec('Lire les résultats', `<ul>
      <li>La grande valeur est la vitesse moyenne de la montée de la dernière rep, en m/s.</li>
      <li>Les barres comparent chaque rep à ta meilleure de la série : vert jusqu'à 10 % de perte, orange jusqu'à 20 %, rouge au-delà. Ce repère vient de l'app, ce n'est pas une règle scientifique.</li>
      <li>Touche une barre pour voir le détail. « Rep ratée » l'exclut des calculs, « Supprimer » l'efface.</li>
      <li>Onglets : Séance (mesurer), 1RM du jour (ton profil charge-vitesse), Historique (toutes tes séances dans l'ordre du temps), Stats (évolution du 1RM, estimations, vitesses).</li>
    </ul>`)}
    ${sec('Les réglages', `<ul>
      <li>Alerte d'arrêt : trois bips graves quand la vitesse a perdu 10, 20 ou 30 % par rapport à ta meilleure rep.</li>
      <li>Repos : un compte à rebours démarre à la fin de la série, avec deux bips à zéro.</li>
      <li>Vitesse cible : une ligne sur les barres et l'écart de chaque rep.</li>
      <li>Son : bip de rep (aigu en zone verte, grave en zone rouge) et alertes.</li>
      <li>Test de mesure, Amplitude : n'est pas validé, à réserver aux essais.</li>
    </ul>`)}
    ${sec('Vitesse minimale', `<ul>
      <li>C'est la vitesse de ta dernière rep réussie, juste avant l'échec : elle sert à calculer le 1RM.</li>
      <li>La valeur par défaut est une moyenne. Après une rep réussie à l'échec, touche « Définir comme vitesse minimale » pour utiliser la tienne : l'estimation devient plus juste.</li>
    </ul>`)}
    ${sec('Tes données', `<ul>
      <li>Pas de compte : tout est enregistré sur ce téléphone, dans le navigateur, et rien n'est envoyé sur internet.</li>
      <li>Effacer les données du site ou changer de téléphone fait tout perdre. Exporte l'historique (onglet Historique) pour en garder une copie.</li>
      <li>Plusieurs personnes peuvent partager le téléphone avec des profils séparés (sélecteur de profil en haut des écrans).</li>
    </ul>`)}
    ${sec('Limites', `<ul>
      <li>Les valeurs viennent d'un capteur de téléphone, non validé sur barre réelle : compare les tendances, pas un chiffre isolé, et pas avec d'autres appareils.</li>
      <li>Chrome sur Android donne environ 60 mesures par seconde : très bien pour la vitesse moyenne, moins pour le pic.</li>
    </ul>`)}
    ${sec('Un retour, un problème ?', `<p class="hint">Les retours se font par une « issue » sur GitHub (un compte GitHub est nécessaire). Le formulaire s'ouvre avec ton appareil, ton navigateur et la fréquence des capteurs déjà remplis, rien d'autre. ${feedbackLink('Écrire un retour')}</p>`)}
    ${DISCLAIMER}
    <button class="btn" data-act="guidehide">${db.settings.guideSeen ? 'Retour à la séance' : "Compris, c'est parti"}</button>`;
}

// ---------- premier lancement : choix du profil et explication des données ----------
function renderWelcome() {
  $('#app').innerHTML = `
    <header class="top"><h1>VBT</h1></header>
    <p class="lead">Mesure la vitesse de ta barre avec le capteur de ton téléphone, pour doser ta charge et suivre ta progression.</p>
    ${envNotice()}
    <section class="guide"><h2 class="cap">Tes données restent chez toi</h2><ul>
      <li>Il n'y a pas de compte et rien n'est envoyé sur internet.</li>
      <li>Tes séries sont enregistrées uniquement sur ce téléphone, dans le navigateur.</li>
      <li>Si tu effaces les données du site ou si tu changes de téléphone, elles sont perdues. L'historique peut s'exporter en fichier pour en garder une copie.</li>
      <li>Plusieurs personnes peuvent utiliser le même téléphone avec des profils séparés.</li>
    </ul></section>
    <section class="guide"><h2 class="cap">Pour commencer</h2>
      <label class="field"><span class="cap">Ton prénom ou un pseudo</span><input id="firstName" class="txt" type="text" maxlength="24" autocomplete="off" placeholder="Prénom"></label>
      <button class="btn" data-act="firstprofile">Commencer</button>
      <button class="btn alt" data-act="firstdemo">Essayer avec une série simulée</button>
    </section>
    ${DISCLAIMER}
    <p class="hint"><a class="link" href="${location.pathname}?demo=1">Voir l'app avec des données d'exemple</a> : un profil, 8 semaines de séances, rien n'est enregistré chez toi.</p>
    <p class="hint">Un problème, une idée ? ${feedbackLink('Écris-le sur GitHub')} (un compte GitHub est nécessaire).</p>`;
}
function firstProfile(demo = false) {
  const name = cleanName($('#firstName') && $('#firstName').value) || (demo && !($('#firstName') && $('#firstName').value.trim()) ? 'Invité' : null);
  if (!name) { if (!demo) toast('Entre un prénom ou un pseudo.'); return; }
  const p = { id: store.newId(), name, mvt: { ...MVT_DEFAULT }, mvtCustom: {} };
  db.profiles.push(p); db.activeProfile = p.id; store.save(db);
  S.tab = 'seance'; render();
  if (demo) simulate();
}

// ---------- profils ----------
function whoBar() {
  return `<div class="whoWrap"><label class="who"><select id="profSel" aria-label="Profil">${db.profiles.map(p => `<option value="${p.id}"${p.id === db.activeProfile ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">+ Nouveau profil…</option></select></label><button class="help" data-act="guide" aria-label="Guide d'utilisation">?</button></div>`;
}
function cleanName(raw, exceptId) {
  const name = (raw || '').trim().slice(0, 24);
  if (!name) return null;
  if (db.profiles.some(p => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) { toast(`Le profil « ${name} » existe déjà.`); return null; }
  return name;
}
function createProfile() {
  const name = cleanName(prompt('Nom du nouveau profil'));
  if (name) {
    const p = { id: store.newId(), name, mvt: { ...MVT_DEFAULT } };
    db.profiles.push(p); db.activeProfile = p.id; store.save(db);
    toast(`Profil « ${name} » créé`);
  }
  render();
}
function renameProfile(id) {
  const p = db.profiles.find(x => x.id === id); if (!p) return;
  const name = cleanName(prompt('Nouveau nom', p.name), id);
  if (name) { p.name = name; store.save(db); }
  render();
}
function deleteProfile(id) {
  const n = db.sets.filter(s => s.profileId === id).length;
  if (n || db.profiles.length < 2) return;               // on ne supprime jamais un profil qui a des séries, ni le dernier
  const p = db.profiles.find(x => x.id === id);
  if (!confirm(`Supprimer le profil « ${p.name} » ?`)) return;
  db.profiles = db.profiles.filter(x => x.id !== id);
  if (db.activeProfile === id) db.activeProfile = db.profiles[0].id;
  store.save(db); render();
}

function todaySets(ex, day) { return db.sets.filter(s => s.profileId === db.activeProfile && s.exercise === ex && store.dayKey(s.t) === day); }

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
  let prevX = -99, row = 0;
  [...pts].sort((a, b) => a.load - b.load).forEach(p => {
    const x = X(p.load), close = x - prevX < 36;          // deux charges proches : on évite que les étiquettes se chevauchent
    row = close ? 1 - row : 0;
    s += `<circle cx="${x}" cy="${Y(p.v)}" r="6" fill="oklch(21% 0.02 255)"/>` + (close ? '' : `<text class="bv" x="${x}" y="${Y(p.v) - 12}">${fmt(p.v)}</text>`) + `<text class="bn" x="${x}" y="${H - B + 16 + row * 15}">${kg(p.load)} kg</text>`;
    prevX = x;
  });
  return s + '</svg>';
}

function renderProfil() {
  const day = store.dayKey(Date.now()), ex = S.exercise, mvt = prof().mvt[ex];
  const pts = bestPerLoad(todaySets(ex, day)), fit = fitProfile(pts, mvt);
  let body;
  if (!pts.length) body = `<p class="empty">Aucune série aujourd'hui pour ce mouvement. Fais une montée en charge dans l'onglet Séance : 3 ou 4 charges, 1 ou 2 reps rapides chacune.</p>`;
  else {
    const sug = fit.ok ? [0.9, 0.75, 0.6, 0.5, 0.4].map(v => ({ v, l: loadForVelocity(fit, v) })).filter(x => x.l > 0 && x.l < fit.e1rm) : [];
    body = (fit.ok ? `<section class="reading"><p class="cap">1RM estimé du jour · ${EXERCISES[ex]}</p><p class="num">${kg(fit.e1rm)}<span class="unit">kg</span></p><p class="delta quiet">${pts.length} charge${pts.length > 1 ? 's' : ''} · R² ${fmt(fit.r2)}</p><p class="hint">Estimation indicative : elle sert à doser la charge du jour, pas à choisir un poids à tenter.</p></section>` : `<section class="empty"><h2 class="emptyh">1RM pas encore calculable</h2><p>Fais une série avec une autre charge : il faut au moins 2 charges différentes aujourd'hui, idéalement 3 ou plus, de légère à lourde.</p></section>`) +
      (pts.length > 1 ? `<section class="block"><h2 class="cap">Charge et vitesse</h2>${profileSvg(pts, fit, mvt)}</section>` : '') +
      (fit.ok && fit.warnings.length ? fit.warnings.map(w => `<p class="note alert"><strong>Attention.</strong> ${w}</p>`).join('') : '') +
      (sug.length ? `<section class="block"><h2 class="cap">Charge pour une vitesse cible</h2><table>${sug.map(x => `<tr><td>${fmt(x.v)} m/s</td><td>${kg(Math.round(x.l / 2.5) * 2.5)} kg</td></tr>`).join('')}</table></section>` : '');
  }
  $('#app').innerHTML = `<header class="top"><h1>1RM du jour</h1>${whoBar()}</header>
    <div class="ex" role="group" aria-label="Mouvement">${Object.entries(EXERCISES).map(([k, n]) => `<button data-act="ex" data-v="${k}" class="${k === ex ? 'on' : ''}" aria-pressed="${k === ex}">${n}</button>`).join('')}</div>
    ${body}
    ${mvtNote(ex, prof().mvtCustom[ex]) ? `<p class="note"><strong>Prudence.</strong> ${mvtNote(ex, prof().mvtCustom[ex])}</p>` : ''}
    <section class="block"><div class="setting"><label class="cap" for="mvtIn">Vitesse minimale<span class="sub">${prof().mvtCustom[ex] ? 'la tienne' : 'valeur par défaut'}</span></label><input id="mvtIn" type="number" step="0.01" inputmode="decimal" value="${mvt}"></div>
      <p class="hint" style="margin-top:8px">Valeurs de départ indicatives : squat 0,30 (valeur générale) · bench 0,17 · deadlift 0,15, non confirmée par la littérature (0,25 relevé pour la barre hexagonale). Le mieux : ta propre vitesse à l'échec, via « Définir comme vitesse minimale » dans le détail d'une rep.</p></section>`;
}

// ---------- historique : courbe de progression par exercice, séances, détail d'une série ----------
function lineSvg(pts, f) {
  const W = 320, H = 170, L = 16, R = 16, T = 24, B = 30, n = pts.length;
  const vs = pts.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo) * 0.3 || hi * 0.05 || 0.05, y0 = lo - pad, y1 = hi + pad;
  const X = i => (n === 1 ? W / 2 : L + (i * (W - L - R)) / (n - 1)), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const labelled = i => n <= 6 || i === 0 || i === n - 1 || pts[i].v === hi;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de progression, une séance par point">`;
  s += `<line class="base" x1="${L}" y1="${H - B + 8}" x2="${W - R}" y2="${H - B + 8}"/>`;
  if (n > 1) s += `<polyline class="line" points="${pts.map((p, i) => `${X(i)},${Y(p.v)}`).join(' ')}"/>`;
  pts.forEach((p, i) => {
    s += `<circle class="dot${i === n - 1 ? ' last' : ''}" cx="${X(i)}" cy="${Y(p.v)}" r="${i === n - 1 ? 7 : 5}"/>`;
    if (labelled(i)) s += `<text class="bv" x="${X(i)}" y="${Y(p.v) - 13}">${f(p.v)}</text>`;
    if (n <= 5 || i === 0 || i === n - 1) s += `<text class="bn" x="${X(i)}" y="${H - 6}">${dateShort(p.day)}</text>`;
  });
  return s + '</svg>';
}

function renderHisto() {
  return S.h.view === 'set' && hset() ? renderHistoSet() : renderHistoList();
}

function renderHistoList() {
  const h = S.h, p = prof(), ex = h.ex;
  // une entrée par jour ; « all » mélange les trois mouvements dans l'ordre du temps
  const days = ex === 'all'
    ? [...db.sets.filter(x => x.profileId === p.id).reduce((m, x) => { const d = store.dayKey(x.t); (m.get(d) || m.set(d, []).get(d)).push(x); return m; }, new Map())]
        .sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, list]) => ({ day, sets: list.sort((a, b) => a.t - b.t), nReps: list.reduce((t, x) => t + repCount(x), 0), volume: list.reduce((t, x) => t + x.load * repCount(x), 0), e1rm: null }))
    : sessions(db.sets, ex, p.id, p.mvt);
  const shown = [...days].reverse().slice(0, h.limit || 4), hidden = days.length - shown.length;
  let list = days.length ? '' : `<section class="empty"><h2 class="emptyh">Aucune série pour l'instant</h2><p>Les séances de ${esc(p.name)} apparaissent ici dès que tu en termines une.</p></section>`;
  for (const s of shown) {
    list += `<h2 class="day">${dateLong(s.day)}</h2><p class="cap">${s.e1rm != null ? `1RM du jour ≈ ${kg(s.e1rm)} kg · ` : ''}${s.sets.length} série${s.sets.length > 1 ? 's' : ''} · ${s.nReps} reps · volume ${Math.round(s.volume)} kg</p>`;
    list += `<div class="hlist">` + s.sets.map(x => {
      const m = setSummary(x), time = new Date(x.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      return `<button class="hset" data-act="hopen" data-id="${x.id}"><span><b>${ex === 'all' ? `${EXERCISES[x.exercise]} · ` : ''}${kg(x.load)} kg × ${m.n}${m.failed ? ` · ${m.failed} ratée${m.failed > 1 ? 's' : ''}` : ''}</b><small>${time}${m.manual ? ' · sans capteur' : ` · moy. ${fmt(m.mean)} m/s${m.n > 1 ? ` · −${Math.round(m.loss * 100)} %` : ''}${x.target ? ` · cible ${fmt(x.target)}` : ''}`}</small></span><span class="hv">${m.manual ? '' : fmt(m.best)}<small>${m.manual ? '' : 'm/s'}</small></span></button>`;
    }).join('') + '</div>';
  }
  if (hidden > 0) list += `<button class="btn alt" data-act="hmore">Voir les séances précédentes (${hidden})</button>`;
  const profs = `<section class="block"><h2 class="cap">Profils</h2>${db.profiles.map(q => {
    const n = db.sets.filter(x => x.profileId === q.id).length, locked = n > 0 || db.profiles.length < 2;
    return `<div class="hrow"><div><b>${esc(q.name)}</b><span>${n} série${n > 1 ? 's' : ''}</span></div><div class="prow"><button class="btn alt sm" data-act="pren" data-id="${q.id}">Renommer</button><button class="btn alt sm" data-act="pdel" data-id="${q.id}"${locked ? ' disabled' : ''}>Supprimer</button></div></div>`;
  }).join('')}<p class="hint" style="margin-top:8px">Un profil ne se supprime que s'il n'a plus de série : ouvre une série et change son profil pour la déplacer.</p></section>`;
  $('#app').innerHTML = `<header class="top"><h1>Historique</h1>${whoBar()}</header>
    <div class="ex four" role="group" aria-label="Mouvement">${[['all', 'Tout'], ...Object.entries(EXERCISES)].map(([k, n]) => `<button data-act="hex" data-v="${k}" class="${k === ex ? 'on' : ''}" aria-pressed="${k === ex}">${n}</button>`).join('')}</div>
    ${list}${profs}` +
    (db.sets.length ? `<button class="btn alt" data-act="exporthist">Exporter l'historique (JSON)</button>` : '');
}

// ---------- stats : évolution du 1RM, estimations, vitesses ----------
const RM_ROWS = [1, 2, 3, 5, 8, 10];
function renderStats() {
  const st = S.st, p = prof(), ex = st.ex;
  const sess = sessions(db.sets, ex, p.id, p.mvt), loads = loadsUsed(sess);
  if (st.load == null || !loads.includes(st.load)) st.load = loads[0] ?? null;
  const metric = st.metric === 'vel' && st.load != null ? 'vel' : 'e1rm';
  const pts = progress(sess, metric, st.load);
  const fv = metric === 'e1rm' ? v => kg(v) : v => fmt(v), unit = metric === 'e1rm' ? 'kg' : 'm/s';
  let body = '';
  if (!sess.length) body = `<section class="empty"><h2 class="emptyh">Pas encore de stats</h2><p>Termine une série de ${EXERCISES[ex].toLowerCase()} : l'évolution de ton 1RM, tes estimations et tes vitesses s'affichent ici.</p></section>`;
  else {
    const last = pts[pts.length - 1], first = pts[0], diff = last && last !== first ? last.v - first.v : null;
    const delta = diff == null ? '' : `${diff >= 0 ? '+' : '−'}${metric === 'e1rm' ? kg(Math.abs(diff)) : fmt(Math.abs(diff))} ${unit} depuis le ${dateShort(first.day)}`;
    body += `<div class="seg" role="group" aria-label="Courbe affichée">
        <button data-act="smetric" data-v="e1rm" class="${metric === 'e1rm' ? 'on' : ''}" aria-pressed="${metric === 'e1rm'}">1RM estimé</button>
        <button data-act="smetric" data-v="vel" class="${metric === 'vel' ? 'on' : ''}" aria-pressed="${metric === 'vel'}">Vitesse</button></div>` +
      (metric === 'vel' ? `<div class="setting"><label class="cap" for="sLoad">Charge</label><select id="sLoad" class="sel">${loads.map(l => `<option value="${l}"${l === st.load ? ' selected' : ''}>${kg(l)} kg</option>`).join('')}</select></div>` : '') +
      (pts.length ? `<section class="reading"><p class="cap">${metric === 'e1rm' ? '1RM estimé' : `Meilleure vitesse à ${kg(st.load)} kg`} · dernière séance</p>
          <p class="stat">${fv(last.v)}<span class="unit">${unit}</span></p><p class="delta quiet">${delta || (pts.length === 1 ? 'Une seule séance : la courbe se trace à partir de la 2e.' : '')}</p></section>${lineSvg(pts, fv)}${metric === 'e1rm' ? '<p class="hint">Estimation indicative, pas un poids à tenter. Le 1RM du deadlift est le moins fiable.</p>' : ''}`
        : `<section class="empty"><h2 class="emptyh">${metric === 'e1rm' ? 'Pas encore de 1RM estimé' : 'Aucune série à cette charge'}</h2><p>${metric === 'e1rm' ? 'Il faut au moins 2 charges différentes dans une même séance. Fais une montée en charge dans l\'onglet Séance.' : 'Choisis une autre charge ci-dessus.'}</p></section>`);

    // estimations de RM à partir du dernier 1RM estimé (formule d'Epley, normalisée pour que 1 rep = 1RM estimé), à côté des records réels
    const e1 = [...sess].reverse().find(x => x.e1rm != null)?.e1rm;
    const rec = new Map(repMaxes(db.sets, ex, p.id, 10).map(x => [x.n, x]));
    body += `<section class="block"><h2 class="cap">Estimations et records</h2>
      <table class="rm"><thead><tr><th></th><th>Estimé</th><th>Record</th></tr></thead><tbody>${RM_ROWS.map(n => {
        const est = e1 != null ? kg(Math.round(((e1 * (1 + 1 / 30)) / (1 + n / 30)) / 2.5) * 2.5) + ' kg' : '-', r = rec.get(n);
        return `<tr><td><b>${n}RM</b></td><td>${est}</td><td>${r ? `<button class="linkbtn" data-act="hopen" data-id="${r.setId}">${kg(r.load)} kg</button>` : '-'}</td></tr>`;
      }).join('')}</tbody></table>
      <p class="hint">${e1 != null ? `Estimé : à partir de ton dernier 1RM estimé (${kg(e1)} kg), avec la formule d'Epley. Indicatif.` : 'Estimé : il faut un 1RM estimé (2 charges différentes dans une séance).'} Record : ta charge la plus lourde tenue sur N reps valides.</p></section>`;

    // meilleure vitesse à chaque charge, toutes séances confondues
    const best = new Map();
    for (const x of db.sets) {
      if (x.profileId !== p.id || x.exercise !== ex || x.manual) continue;
      for (const r of activeReps(x.reps)) { const b = best.get(x.load); if (!b || r.mcv > b.v) best.set(x.load, { v: r.mcv, t: x.t }); }
    }
    const rows = [...best].sort((a, b) => a[0] - b[0]);
    if (rows.length) body += `<section class="block"><h2 class="cap">Meilleure vitesse par charge</h2>
      <table class="rm"><thead><tr><th>Charge</th><th>Vitesse</th><th>Date</th></tr></thead><tbody>${rows.map(([l, b]) => `<tr><td><b>${kg(l)} kg</b></td><td>${fmt(b.v)} m/s</td><td>${dateShort(store.dayKey(b.t))}</td></tr>`).join('')}</tbody></table></section>`;

    const totReps = sess.reduce((t, x) => t + x.nReps, 0), totVol = sess.reduce((t, x) => t + x.volume, 0);
    body += `<section class="block"><h2 class="cap">Au total</h2><p class="hint">${sess.length} séance${sess.length > 1 ? 's' : ''} · ${totReps} reps · volume ${Math.round(totVol).toLocaleString('fr-FR')} kg</p></section>`;
  }
  $('#app').innerHTML = `<header class="top"><h1>Stats</h1>${whoBar()}</header>
    <div class="ex" role="group" aria-label="Mouvement">${Object.entries(EXERCISES).map(([k, n]) => `<button data-act="sex" data-v="${k}" class="${k === ex ? 'on' : ''}" aria-pressed="${k === ex}">${n}</button>`).join('')}</div>
    ${body}`;
}

const hset = () => db.sets.find(s => s.id === S.h.setId);

function renderHistoSet() {
  const s = hset(), m = setSummary(s), day = store.dayKey(s.t), h = S.h;
  const time = new Date(s.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const head = `<header class="top"><button class="back" data-act="hback">← Historique</button></header>
    <section class="reading"><p class="cap">${dateLong(day)} · ${time}${s.target ? ` · cible ${fmt(s.target)} m/s` : ''}</p>
      <p class="stat">${kg(s.load)}<span class="unit">kg · ${EXERCISES[s.exercise]}</span></p></section>`;
  const foot = `<section class="block"><div class="setting"><label class="cap" for="setProf">Profil de cette série</label>
      <select id="setProf" class="sel">${db.profiles.map(q => `<option value="${q.id}"${q.id === s.profileId ? ' selected' : ''}>${esc(q.name)}</option>`).join('')}</select></div></section>
    <button class="btn alt" data-act="hdelset">Supprimer la série</button>`;
  if (s.manual) {
    $('#app').innerHTML = head + `<dl class="facts"><div><dt>Reps</dt><dd>${m.n}</dd></div></dl><p class="note">Série saisie à la main, sans capteur : pas de vitesse mesurée. Elle compte dans le volume et les records.</p>` + foot;
    return;
  }
  $('#app').innerHTML = head + `
    <dl class="facts">
      <div><dt>Reps</dt><dd>${m.n}${m.failed ? `<small>+${m.failed} ratée${m.failed > 1 ? 's' : ''}</small>` : ''}</dd></div>
      <div><dt>Meilleure</dt><dd>${fmt(m.best)}</dd></div>
      <div><dt>Moyenne</dt><dd>${fmt(m.mean)}</dd></div>
      <div><dt>Perte</dt><dd>${Math.round(m.loss * 100)}<small>%</small></dd></div>
    </dl>
    <section class="reps"><h2 class="cap">Reps · touche une barre pour le détail</h2>${barsSvg(s.reps, h.sel, null, 'hsel', s.target ?? null)}</section>
    ${detailHtml(s.reps, h.sel, ['hfail', 'hdelrep', 'hsetmvt'])}` + foot;
}

function histoPersist() {
  const s = hset();
  if (s && !s.manual && !s.reps.length) { db.sets = db.sets.filter(x => x !== s); S.h.view = 'list'; S.h.setId = null; toast('Série vide supprimée'); }
  store.save(db); renderHisto();
}

function render() {
  document.body.classList.remove('has-dock');
  document.body.classList.toggle('welcome', !db.profiles.length);
  if (!db.profiles.length) return renderWelcome();
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === S.tab));
  ({ seance: renderSeance, profil: renderProfil, histo: renderHisto, stats: renderStats, guide: renderGuide })[S.tab]();
}

let toastT;
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 3000); }

// ---------- événements ----------
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, v = el.dataset.v;
  unlockAudio();                                      // Chrome n'autorise le son qu'après un toucher
  if (act === 'tgt') { const d = parseFloat(v), t = S.target ? Math.round((S.target + d) * 100) / 100 : (d > 0 ? 0.6 : null); S.target = t == null || t < 0.1 ? null : Math.min(2, t); db.last.target = S.target; store.save(db); renderSeance(); }
  else if (act === 'copylink') { (navigator.clipboard ? navigator.clipboard.writeText(location.href.split('#')[0]) : Promise.reject()).then(() => toast('Lien copié : colle-le dans Chrome ou Safari.'), () => toast(location.href)); }
  else if (act === 'firstprofile') firstProfile();
  else if (act === 'hmore') { S.h.limit = (S.h.limit || 4) + 6; renderHisto(); }
  else if (act === 'firstdemo') firstProfile(true);
  else if (act === 'guide') { if (S.tab !== 'guide') S.back = S.tab; S.tab = 'guide'; render(); window.scrollTo(0, 0); }
  else if (act === 'guideback') { S.tab = S.back || 'seance'; render(); window.scrollTo(0, 0); }
  else if (act === 'guidehide') { db.settings.guideSeen = true; store.save(db); S.tab = 'seance'; render(); window.scrollTo(0, 0); }
  else if (act === 'manual') { addManualSet(); renderSeance(); }
  else if (act === 'setmvt') { setMvtFromRep(S.reps[S.selected], db.activeProfile, S.exercise); renderSeance(); }
  else if (act === 'hsetmvt') { const hs = hset(); if (hs) setMvtFromRep(hs.reps[S.h.sel], hs.profileId, hs.exercise); renderHisto(); }
  else if (act === 'rest') { db.settings.rest = parseInt(v, 10); store.save(db); renderSeance(); }
  else if (act === 'restskip') { stopRest(); renderSeance(); }
  else if (act === 'loss') { db.settings.lossStop = parseFloat(v); store.save(db); renderSeance(); }
  else if (act === 'tog') { db.settings[v] = !db.settings[v]; store.save(db); renderSeance(); }
  else if (act === 'fail') toggleFailed(S.selected);
  else if (act === 'delrep') deleteRep(S.selected);
  else if (act === 'exportraw') exportRaw();
  else if (act === 'exporthist') exportHistory();
  else if (act === 'ex') { S.exercise = v; db.last.exercise = v; store.save(db); render(); }
  else if (act === 'load') { S.load = Math.max(0, S.load + parseFloat(v)); db.last.load = S.load; store.save(db); renderSeance(); }
  else if (act === 'sel') { S.selected = parseInt(el.dataset.i, 10); renderSeance(); }
  else if (act === 'connect') connect();
  else if (act === 'connect-phone') connect('phone');
  else if (act === 'disconnect') disconnect();
  else if (act === 'start') startSet();
  else if (act === 'end') endSet();
  else if (act === 'sim') simulate();
  else if (act === 'hex') { S.h.ex = v; S.h.load = null; S.h.limit = 4; renderHisto(); }
  else if (act === 'sex') { S.st.ex = v; S.st.load = null; renderStats(); }
  else if (act === 'smetric') { S.st.metric = v; renderStats(); }
  else if (act === 'hopen') { if (S.tab !== 'histo') { S.tab = 'histo'; S.h.ex = 'all'; } S.h.setId = parseInt(el.dataset.id, 10); S.h.view = 'set'; S.h.sel = Math.max(0, (hset()?.reps.length || 1) - 1); render(); window.scrollTo(0, 0); }
  else if (act === 'hback') { S.h.view = 'list'; S.h.setId = null; renderHisto(); window.scrollTo(0, 0); }
  else if (act === 'hsel') { S.h.sel = parseInt(el.dataset.i, 10); renderHisto(); }
  else if (act === 'hfail') { const r = hset()?.reps[S.h.sel]; if (r) { if (r.failed) delete r.failed; else r.failed = true; histoPersist(); } }
  else if (act === 'hdelrep') { const s = hset(); if (s && s.reps[S.h.sel]) { s.reps.splice(S.h.sel, 1); S.h.sel = Math.max(0, Math.min(S.h.sel, s.reps.length - 1)); histoPersist(); } }
  else if (act === 'hdelset') { if (confirm('Supprimer cette série ?')) { db.sets = db.sets.filter(x => x.id !== S.h.setId); S.h.view = 'list'; S.h.setId = null; store.save(db); renderHisto(); } }
  else if (act === 'pren') renameProfile(el.dataset.id);
  else if (act === 'pdel') deleteProfile(el.dataset.id);
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'firstName') firstProfile(); });
document.addEventListener('toggle', e => { if (e.target.id === 'optsBox') S.optsOpen = e.target.open; else if (e.target.id === 'moreBox') S.moreOpen = e.target.open; }, true);

document.addEventListener('change', e => {
  if (e.target.id === 'profSel') {
    if (e.target.value === '__new') createProfile();
    else { db.activeProfile = e.target.value; store.save(db); render(); }
  }
  if (e.target.id === 'sLoad') { S.st.load = parseFloat(e.target.value); renderStats(); }
  if (e.target.id === 'setProf') {
    const s = hset(), p = db.profiles.find(q => q.id === e.target.value);
    if (s && p) { s.profileId = p.id; store.save(db); S.h.view = 'list'; S.h.setId = null; toast(`Série déplacée vers ${p.name}`); render(); }
  }
  if (e.target.id === 'loadIn') { S.load = Math.max(0, parseFloat(e.target.value) || 0); db.last.load = S.load; store.save(db); }
  if (e.target.id === 'mvtIn') { const m = prof().mvt; m[S.exercise] = Math.max(0.05, parseFloat(e.target.value) || m[S.exercise]); prof().mvtCustom[S.exercise] = true; store.save(db); renderProfil(); }
});
$('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.tab = b.dataset.v; render(); } });

render();
// ---------- mise à jour de l'app ----------
function showUpdate(worker) {
  if ($('#update')) return;
  const bar = document.createElement('div');
  bar.id = 'update'; bar.setAttribute('role', 'status');
  bar.innerHTML = '<span>Nouvelle version disponible</span><button class="btn sm" type="button">Recharger</button>';
  bar.querySelector('button').onclick = () => {
    if (S.recording && !confirm('Une série est en cours : la recharger la perdrait. Recharger quand même ?')) return;
    reloading = true; worker.postMessage('SKIP_WAITING');
  };
  document.body.appendChild(bar);
}
let reloading = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) location.reload(); });
  navigator.serviceWorker.register('sw.js').then(reg => {
    const watch = w => w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w); });
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => reg.installing && watch(reg.installing));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => { /* hors-ligne indisponible, sans gravité */ });
}
