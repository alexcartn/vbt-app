// Historique : séances par exercice et par profil, courbes de progression, résumé d'une série.
import { bestPerLoad, fitProfile } from './profile.js';
import { activeReps, setStats } from './feedback.js';
import { dayKey } from './store.js';

/** Séries d'un exercice et d'un profil, regroupées par jour, triées de la plus ancienne à la plus récente. */
export function sessions(sets, exercise, profileId, mvt) {
  const byDay = new Map();
  for (const s of sets) {
    if (s.exercise !== exercise || s.profileId !== profileId) continue;
    const d = dayKey(s.t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(s);
  }
  return [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, list]) => {
    list.sort((a, b) => a.t - b.t);
    const fit = fitProfile(bestPerLoad(list), mvt[exercise]);
    const volume = list.reduce((t, s) => t + s.load * activeReps(s.reps).length, 0);
    return { day, sets: list, fit, e1rm: fit.ok ? fit.e1rm : null, volume, nReps: list.reduce((t, s) => t + activeReps(s.reps).length, 0) };
  });
}

/** Points de la courbe de progression : 1RM estimé du jour, ou meilleure vitesse à une charge donnée. */
export function progress(sess, metric, load) {
  const pts = [];
  for (const s of sess) {
    if (metric === 'e1rm') { if (s.e1rm != null) pts.push({ day: s.day, v: s.e1rm }); }
    else {
      const best = s.sets.filter(x => x.load === load).flatMap(x => activeReps(x.reps).map(r => r.mcv));
      if (best.length) pts.push({ day: s.day, v: Math.max(...best) });
    }
  }
  return pts;
}

/** Charges utilisées, la plus fréquente d'abord (à égalité, la plus légère). */
export function loadsUsed(sess) {
  const n = new Map();
  for (const s of sess) for (const x of s.sets) n.set(x.load, (n.get(x.load) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([l]) => l);
}

/** Résumé d'une série : reps valides, ratées, meilleure et moyenne, perte de vitesse de la dernière rep. */
export function setSummary(set) {
  const act = activeReps(set.reps), st = setStats(set.reps);
  return {
    n: act.length, failed: set.reps.length - act.length, best: st.best, loss: st.loss,
    mean: act.length ? act.reduce((t, r) => t + r.mcv, 0) / act.length : 0
  };
}
