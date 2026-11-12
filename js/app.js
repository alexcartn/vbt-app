import { Tracker } from './signal.js';
import { Sensor, bleSupported } from './ble.js';
import { PhoneSensor, phoneSupported } from './phone.js';
import { generateSet } from './sim.js';
import * as store from './store.js';
import { EXERCISES, MVT_DEFAULT, bestPerLoad, fitProfile, loadForVelocity, mvtNote } from './profile.js';
import { activeReps, setStats, shouldStop, rawCsv, restDisplay, targetDelta } from './feedback.js';
import { sessions, progress, loadsUsed, setSummary, repMaxes } from './history.js';
import { unlockAudio, beepRep, beepStop, beepReady } from './audio.js';

const $ = s => document.querySelector(s);
const fmt = (v, d = 2) => (v == null || isNaN(v) ? '-' : v.toFixed(d).replace('.', ','));
const kg = x => (Math.round(x * 2) / 2).toString().replace('.', ',');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dateLong = d => new Date(d + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const dateShort = d => `${d.slice(8)}/${d.slice(5, 7)}`;

let db = store.load();
const prof = () => db.profiles.find(p => p.id === db.activeProfile);
const tracker = new Tracker();
let gyro = [0, 0, 0], sensor = null, connected = false, simTimer = null, lastState = 'calib', wakeLock = null;
const S = {
  tab: 'seance', exercise: db.last.exercise, load: db.last.load, target: db.last.target ?? null,   // target : vitesse cible (m/s) ou null
  recording: false, reps: [], selected: null, fresh: null, hz: 0, rate: { n: 0, t0: 0 }, msg: '',
  h: { view: 'list', ex: db.last.exercise, metric: 'e1rm', load: null, setId: null, sel: null },   // onglet Historique
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
  const best = setStats(reps).best || Math.max(...reps.map(r => r.mcv)), top = Math.max(1, best * 1.12, (target || 0) * 1.1);
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
      ${db.settings.showRom ? `<div><dt>Amplitude à valider</dt><dd>${Math.round(r.rom * 100)}<small>cm</small></dd></div>` : `<div><dt>Écart à la meilleure</dt><dd>${gap > 0 ? '−' : ''}${gap}<small>%</small></dd></div>`}
    </dl>
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
  const actions = `
    <div class="actions${S.recording ? ' sticky' : ''}">
      ${!connected && !simTimer ? `<button class="btn" data-act="connect">Connecter le capteur</button><button class="btn alt" data-act="connect-phone">Utiliser le téléphone</button>` : ''}
      ${(connected || simTimer) && !S.recording ? `<button class="btn" data-act="start">Démarrer la série</button>` : ''}
      ${S.recording ? `<button class="btn" data-act="end">Terminer la série</button>` : ''}
      ${!S.recording ? `<details class="more" id="moreBox"${S.moreOpen ? ' open' : ''}><summary class="cap">Plus</summary>
        ${!connected && !simTimer ? `<button class="btn alt" data-act="sim">Simuler une série</button>` : ''}
        <button class="btn alt" data-act="manual">Série sans capteur</button>
        ${S.raw.length > 50 ? `<button class="btn alt" data-act="exportraw">Exporter les données brutes (CSV)</button>` : ''}
        ${connected ? `<button class="btn alt" data-act="disconnect">Déconnecter</button>` : ''}
      </details>` : ''}
    </div>`;
  $('#app').innerHTML = `
    <header class="top"><span id="chip" class="chip"></span>${S.recording ? `<span class="ctx">${esc(prof().name)} · ${EXERCISES[S.exercise]} · ${kg(S.load)} kg</span>` : whoBar()}</header>
    ${restHtml()}
    ${setup}
    ${S.recording ? '' : actions}
    <section class="reading" aria-live="polite">
      <p class="cap">${last ? `Rep ${lastNo} · vitesse moyenne` : 'Vitesse moyenne'}</p>
      <p class="num${last ? '' : ' none'}">${last ? fmt(last.mcv) : '0,00'}<span class="unit">m/s</span></p>
      ${delta}
    </section>
    <section class="reps"><h2 class="cap">Reps${S.reps.length ? ' · touche une barre pour le détail' : ''}</h2>${barsSvg()}</section>
    ${detailHtml()}
    ${S.recording ? actions : ''}`;
  renderStatus();
}

// ---------- profils ----------
function whoBar() {
  return `<label class="who"><span class="cap">Profil</span><select id="profSel" aria-label="Profil">${db.profiles.map(p => `<option value="${p.id}"${p.id === db.activeProfile ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">+ Nouveau profil…</option></select></label>`;
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
  pts.forEach(p => { s += `<circle cx="${X(p.load)}" cy="${Y(p.v)}" r="6" fill="oklch(21% 0.02 255)"/><text class="bv" x="${X(p.load)}" y="${Y(p.v) - 12}">${fmt(p.v)}</text><text class="bn" x="${X(p.load)}" y="${H - B + 16}">${kg(p.load)} kg</text>`; });
  return s + '</svg>';
}

function renderProfil() {
  const day = store.dayKey(Date.now()), ex = S.exercise, mvt = prof().mvt[ex];
  const pts = bestPerLoad(todaySets(ex, day)), fit = fitProfile(pts, mvt);
  let body;
  if (!pts.length) body = `<p class="empty">Aucune série aujourd'hui pour ce mouvement. Fais une montée en charge dans l'onglet Séance : 3 ou 4 charges, 1 ou 2 reps rapides chacune.</p>`;
  else {
    const sug = fit.ok ? [0.9, 0.75, 0.6, 0.5, 0.4].map(v => ({ v, l: loadForVelocity(fit, v) })).filter(x => x.l > 0 && x.l < fit.e1rm) : [];
    body = (fit.ok ? `<section class="reading"><p class="cap">1RM estimé du jour · ${EXERCISES[ex]}</p><p class="num">${kg(fit.e1rm)}<span class="unit">kg</span></p><p class="delta quiet">${pts.length} charge${pts.length > 1 ? 's' : ''} · R² ${fmt(fit.r2)}</p><p class="hint">Estimation indicative : elle sert à doser la charge du jour, pas à choisir un poids à tenter.</p></section>` : `<p class="note"><strong>Pas d'estimation.</strong> ${fit.reason}</p>`) +
      `<section class="block"><h2 class="cap">Charge et vitesse</h2>${profileSvg(pts, fit, mvt)}</section>` +
      (fit.ok && fit.warnings.length ? fit.warnings.map(w => `<p class="note"><strong>Attention.</strong> ${w}</p>`).join('') : '') +
      (sug.length ? `<section class="block"><h2 class="cap">Charge pour une vitesse cible</h2><table>${sug.map(x => `<tr><td>${fmt(x.v)} m/s</td><td>${kg(Math.round(x.l / 2.5) * 2.5)} kg</td></tr>`).join('')}</table></section>` : '');
  }
  $('#app').innerHTML = `<header class="top"><h1>1RM du jour</h1>${whoBar()}</header>
    <div class="ex" role="group" aria-label="Mouvement">${Object.entries(EXERCISES).map(([k, n]) => `<button data-act="ex" data-v="${k}" class="${k === ex ? 'on' : ''}" aria-pressed="${k === ex}">${n}</button>`).join('')}</div>
    ${body}
    ${mvtNote(ex, prof().mvtCustom[ex]) ? `<p class="note"><strong>Prudence.</strong> ${mvtNote(ex, prof().mvtCustom[ex])}</p>` : ''}
    <section class="block"><div class="setting"><label class="cap" for="mvtIn">Vitesse minimale${prof().mvtCustom[ex] ? ' (la tienne)' : ' (par défaut)'}<br>(dernière rep réussie)</label><input id="mvtIn" type="number" step="0.01" inputmode="decimal" value="${mvt}"></div>
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
  const sess = sessions(db.sets, ex, p.id, p.mvt), loads = loadsUsed(sess);
  if (h.load == null || !loads.includes(h.load)) h.load = loads[0] ?? null;
  const metric = h.metric === 'vel' && h.load != null ? 'vel' : 'e1rm';
  const pts = progress(sess, metric, h.load);
  const fv = metric === 'e1rm' ? v => kg(v) : v => fmt(v), unit = metric === 'e1rm' ? 'kg' : 'm/s';
  let chart;
  if (!sess.length) chart = `<p class="empty">Aucune série de ${esc(p.name)} en ${EXERCISES[ex].toLowerCase()}. Les séries apparaissent ici dès que tu en termines une.</p>`;
  else {
    const last = pts[pts.length - 1], first = pts[0], diff = last && last !== first ? last.v - first.v : null;
    const delta = diff == null ? '' : `${diff >= 0 ? '+' : '−'}${metric === 'e1rm' ? kg(Math.abs(diff)) : fmt(Math.abs(diff))} ${unit} depuis le ${dateShort(first.day)}`;
    chart = `<div class="seg" role="group" aria-label="Courbe affichée">
        <button data-act="hmetric" data-v="e1rm" class="${metric === 'e1rm' ? 'on' : ''}" aria-pressed="${metric === 'e1rm'}">1RM estimé</button>
        <button data-act="hmetric" data-v="vel" class="${metric === 'vel' ? 'on' : ''}" aria-pressed="${metric === 'vel'}">Vitesse</button></div>` +
      (metric === 'vel' ? `<div class="setting"><label class="cap" for="hLoad">Charge</label><select id="hLoad" class="sel">${loads.map(l => `<option value="${l}"${l === h.load ? ' selected' : ''}>${kg(l)} kg</option>`).join('')}</select></div>` : '') +
      (pts.length ? `<section class="reading"><p class="cap">${metric === 'e1rm' ? '1RM estimé' : `Meilleure vitesse à ${kg(h.load)} kg`} · dernière séance</p>
          <p class="stat">${fv(last.v)}<span class="unit">${unit}</span></p><p class="delta quiet">${delta || (pts.length === 1 ? 'Une seule séance : la courbe se trace à partir de la 2e.' : '')}</p></section>${lineSvg(pts, fv)}${metric === 'e1rm' ? '<p class="hint">Estimation indicative, pas un poids à tenter. Le 1RM du deadlift est le moins fiable.</p>' : ''}`
        : `<p class="note"><strong>Pas de point.</strong> ${metric === 'e1rm' ? 'Le 1RM estimé demande au moins 2 charges différentes dans une même séance.' : 'Aucune série à cette charge.'}</p>`);
  }
  const rms = repMaxes(db.sets, ex, p.id);
  let list = rms.length ? `<section class="block"><h2 class="cap">Records · reps valides, séries sans capteur comprises</h2><div class="hlist">${rms.map(x =>
    `<button class="hset" data-act="hopen" data-id="${x.setId}"><span><b>${x.n}RM</b><small>${dateShort(store.dayKey(x.t))}${x.v != null ? ` · moy. ${fmt(x.v)} m/s` : ' · sans capteur'}</small></span><span class="hv">${kg(x.load)}<small>kg</small></span></button>`).join('')}</div></section>` : '';
  for (const s of [...sess].reverse()) {
    list += `<h2 class="day">${dateLong(s.day)}</h2><p class="cap">${s.e1rm != null ? `1RM du jour ≈ ${kg(s.e1rm)} kg · ` : ''}${s.sets.length} série${s.sets.length > 1 ? 's' : ''} · ${s.nReps} reps · volume ${Math.round(s.volume)} kg</p>`;
    list += `<div class="hlist">` + s.sets.map(x => {
      const m = setSummary(x), time = new Date(x.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      return `<button class="hset" data-act="hopen" data-id="${x.id}"><span><b>${kg(x.load)} kg × ${m.n}${m.failed ? ` · ${m.failed} ratée${m.failed > 1 ? 's' : ''}` : ''}</b><small>${time}${m.manual ? ' · sans capteur' : ` · moy. ${fmt(m.mean)} m/s${m.n > 1 ? ` · −${Math.round(m.loss * 100)} %` : ''}${x.target ? ` · cible ${fmt(x.target)}` : ''}`}</small></span><span class="hv">${m.manual ? '–' : `${fmt(m.best)}<small>m/s</small>`}</span></button>`;
    }).join('') + '</div>';
  }
  const profs = `<section class="block"><h2 class="cap">Profils</h2>${db.profiles.map(q => {
    const n = db.sets.filter(x => x.profileId === q.id).length, locked = n > 0 || db.profiles.length < 2;
    return `<div class="hrow"><div><b>${esc(q.name)}</b><span>${n} série${n > 1 ? 's' : ''}</span></div><div class="prow"><button class="btn alt sm" data-act="pren" data-id="${q.id}">Renommer</button><button class="btn alt sm" data-act="pdel" data-id="${q.id}"${locked ? ' disabled' : ''}>Supprimer</button></div></div>`;
  }).join('')}<p class="hint" style="margin-top:8px">Un profil ne se supprime que s'il n'a plus de série : ouvre une série et change son profil pour la déplacer.</p></section>`;
  $('#app').innerHTML = `<header class="top"><h1>Historique</h1>${whoBar()}</header>
    <div class="ex" role="group" aria-label="Mouvement">${Object.entries(EXERCISES).map(([k, n]) => `<button data-act="hex" data-v="${k}" class="${k === ex ? 'on' : ''}" aria-pressed="${k === ex}">${n}</button>`).join('')}</div>
    ${chart}${list}${profs}` +
    (db.sets.length ? `<button class="btn alt" data-act="exporthist">Exporter l'historique (JSON)</button>` : '');
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
  if (act === 'tgt') { const d = parseFloat(v), t = S.target ? Math.round((S.target + d) * 100) / 100 : (d > 0 ? 0.6 : null); S.target = t == null || t < 0.1 ? null : Math.min(2, t); db.last.target = S.target; store.save(db); renderSeance(); }
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
  else if (act === 'hex') { S.h.ex = v; S.h.load = null; renderHisto(); }
  else if (act === 'hmetric') { S.h.metric = v; renderHisto(); }
  else if (act === 'hopen') { S.h.setId = parseInt(el.dataset.id, 10); S.h.view = 'set'; S.h.sel = Math.max(0, (hset()?.reps.length || 1) - 1); renderHisto(); window.scrollTo(0, 0); }
  else if (act === 'hback') { S.h.view = 'list'; S.h.setId = null; renderHisto(); window.scrollTo(0, 0); }
  else if (act === 'hsel') { S.h.sel = parseInt(el.dataset.i, 10); renderHisto(); }
  else if (act === 'hfail') { const r = hset()?.reps[S.h.sel]; if (r) { if (r.failed) delete r.failed; else r.failed = true; histoPersist(); } }
  else if (act === 'hdelrep') { const s = hset(); if (s && s.reps[S.h.sel]) { s.reps.splice(S.h.sel, 1); S.h.sel = Math.max(0, Math.min(S.h.sel, s.reps.length - 1)); histoPersist(); } }
  else if (act === 'hdelset') { if (confirm('Supprimer cette série ?')) { db.sets = db.sets.filter(x => x.id !== S.h.setId); S.h.view = 'list'; S.h.setId = null; store.save(db); renderHisto(); } }
  else if (act === 'pren') renameProfile(el.dataset.id);
  else if (act === 'pdel') deleteProfile(el.dataset.id);
});
document.addEventListener('toggle', e => { if (e.target.id === 'optsBox') S.optsOpen = e.target.open; else if (e.target.id === 'moreBox') S.moreOpen = e.target.open; }, true);

document.addEventListener('change', e => {
  if (e.target.id === 'profSel') {
    if (e.target.value === '__new') createProfile();
    else { db.activeProfile = e.target.value; store.save(db); render(); }
  }
  if (e.target.id === 'hLoad') { S.h.load = parseFloat(e.target.value); renderHisto(); }
  if (e.target.id === 'setProf') {
    const s = hset(), p = db.profiles.find(q => q.id === e.target.value);
    if (s && p) { s.profileId = p.id; store.save(db); S.h.view = 'list'; S.h.setId = null; toast(`Série déplacée vers ${p.name}`); render(); }
  }
  if (e.target.id === 'loadIn') { S.load = Math.max(0, parseFloat(e.target.value) || 0); db.last.load = S.load; store.save(db); }
  if (e.target.id === 'mvtIn') { const m = prof().mvt; m[S.exercise] = Math.max(0.05, parseFloat(e.target.value) || m[S.exercise]); prof().mvtCustom[S.exercise] = true; store.save(db); renderProfil(); }
});
$('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.tab = b.dataset.v; render(); } });

render();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* hors-ligne indisponible, sans gravité */ });
