// Historique : séances par exercice et par profil, courbes de progression, résumé d'une série.
import { bestPerLoad, fitProfile } from './profile.js';
import { activeReps, setStats } from './feedback.js';
import { dayKey } from './store.js';

/** Nombre de reps comptées d'une série : saisie à la main (sans capteur) ou reps valides mesurées. */
export const repCount = set => (set.manual ? set.count : activeReps(set.reps).length);

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
    const nReps = list.reduce((t, s) => t + repCount(s), 0);
    return { day, sets: list, fit, e1rm: fit.ok ? fit.e1rm : null, volume: list.reduce((t, s) => t + s.load * repCount(s), 0), nReps };
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
  if (set.manual) return { n: set.count, failed: 0, best: 0, mean: 0, loss: 0, manual: true };
  const act = activeReps(set.reps), st = setStats(set.reps);
  return {
    n: act.length, failed: set.reps.length - act.length, best: st.best, loss: st.loss,
    mean: act.length ? act.reduce((t, r) => t + r.mcv, 0) / act.length : 0
  };
}

/** Records par nombre de reps : pour N = 1 à maxN, la charge la plus lourde tenue sur au moins N reps valides (à égalité, la plus récente). */
export function repMaxes(sets, exercise, profileId, maxN = 5) {
  const mine = sets.filter(s => s.exercise === exercise && s.profileId === profileId);
  const out = [];
  for (let n = 1; n <= maxN; n++) {
    let best = null;
    for (const s of mine) {
      if (repCount(s) < n) continue;
      if (!best || s.load > best.load || (s.load === best.load && s.t > best.t)) best = s;
    }
    if (best) out.push({ n, load: best.load, t: best.t, setId: best.id, manual: !!best.manual, v: best.manual ? null : setSummary(best).mean });
  }
  return out;
}
