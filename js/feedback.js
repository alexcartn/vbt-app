// Logique pure du retour pendant la série : perte de vitesse, seuil d'arrêt, minuteur de repos, vitesse cible, export brut.

/** Reps comptées : on écarte celles marquées ratées. */
export const activeReps = reps => reps.filter(r => !r.failed);

/** Meilleure vitesse, dernière rep et perte de vitesse (0 à 1) de la dernière rep contre la meilleure. */
export function setStats(reps) {
  const act = activeReps(reps);
  if (!act.length) return { best: 0, last: null, loss: 0, n: 0 };
  const best = Math.max(...act.map(r => r.mcv)), last = act[act.length - 1];
  return { best, last, loss: best > 0 ? Math.max(0, (best - last.mcv) / best) : 0, n: act.length };
}

/** Vrai quand la perte de vitesse atteint le seuil (0 = désactivé). Il faut au moins 2 reps. */
export function shouldStop(reps, threshold) {
  if (!(threshold > 0)) return false;
  const s = setStats(reps);
  // tolérance : 0,8 -> 0,64 vaut 20 % pile malgré les arrondis flottants
  return s.n >= 2 && s.loss >= threshold - 1e-9;
}

/** CSV des échantillons bruts rejouables : une ligne i,ax,ay,az,gx,gy,gz (g et °/s), méta en commentaires. */
export function rawCsv(rows, meta) {
  const date = new Date(meta.t).toISOString();
  return [
    `# vbt-raw hz=${meta.hz} accel=g gyro=deg/s`,
    `# exercice=${meta.exercise} charge=${meta.load}kg date=${date}`,
    'i,ax,ay,az,gx,gy,gz',
    ...rows.map(r => r.join(','))
  ].join('\n') + '\n';
}

/** Minuteur de repos : ms restantes (négatif = dépassement) -> compte à rebours "2:47", puis "+0:12" une fois la durée écoulée. */
export function restDisplay(remainingMs) {
  const over = remainingMs <= 0, sec = over ? Math.floor(-remainingMs / 1000) : Math.ceil(remainingMs / 1000);
  return { over, text: `${over ? '+' : ''}${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` };
}

/** Écart d'une vitesse à la vitesse cible : "+0,03" (atteinte) ou "−0,06" (en dessous). */
export function targetDelta(v, target) {
  const diff = Math.round((v - target) * 100) / 100;
  return { diff, text: `${diff >= 0 ? '+' : '−'}${Math.abs(diff).toFixed(2).replace('.', ',')}`, met: diff >= 0 };
}
