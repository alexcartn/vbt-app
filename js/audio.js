// Bips (Web Audio). Tout échoue en silence : le son n'est jamais bloquant.
let ctx = null;

/** À appeler depuis un geste de l'utilisateur (toucher un bouton) : Chrome refuse de produire du son avant. */
export function unlockAudio() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (_) { /* pas de Web Audio */ }
}

function tone(freq, start, dur, vol = 0.35) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + start;
  o.type = 'square'; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

/** Bip de rep : plus aigu quand la rep est rapide (zone verte), plus grave en zone rouge. */
export function beepRep(zone) {
  try { tone(zone === 'go' ? 880 : zone === 'mid' ? 660 : 440, 0, 0.12); } catch (_) { /* ignore */ }
}

/** Alerte d'arrêt : trois bips graves, impossibles à confondre avec un bip de rep. */
export function beepStop() {
  try { [0, 0.2, 0.4].forEach(s => tone(260, s, 0.15, 0.5)); } catch (_) { /* ignore */ }
}

/** Repos terminé : deux bips aigus, distincts d'un bip de rep (un seul) et de l'alerte d'arrêt (trois graves). */
export function beepReady() {
  try { [0, 0.25].forEach(s => tone(988, s, 0.18, 0.4)); } catch (_) { /* ignore */ }
}
