// Profil charge-vitesse et 1RM estimé du jour.
export const EXERCISES = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift' };

// Vitesse moyenne minimale (vitesse de la dernière rep réussie) : valeurs de la littérature, à régler dans l'app.
export const MVT_DEFAULT = { squat: 0.30, bench: 0.17, deadlift: 0.15 };

/** Meilleure vitesse moyenne par charge, à partir des séries : [{ load, v }] triés par charge. */
export function bestPerLoad(sets) {
  const best = new Map();
  for (const s of sets) {
    const ok = (s.reps || []).filter(r => !r.failed);   // une rep ratée ne fixe pas la meilleure vitesse
    if (!ok.length) continue;
    const v = Math.max(...ok.map(r => r.mcv));
    if (!best.has(s.load) || v > best.get(s.load)) best.set(s.load, v);
  }
  return [...best].map(([load, v]) => ({ load, v })).sort((a, b) => a.load - b.load);
}

/** Régression linéaire vitesse = a + b × charge. Le 1RM est la charge où la droite atteint la vitesse minimale. */
export function fitProfile(points, mvt) {
  const n = points.length;
  if (n < 2) return { ok: false, n, reason: 'Il faut au moins 2 charges différentes.' };
  const mx = points.reduce((t, p) => t + p.load, 0) / n, my = points.reduce((t, p) => t + p.v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) { sxx += (p.load - mx) ** 2; sxy += (p.load - mx) * (p.v - my); syy += (p.v - my) ** 2; }
  if (sxx === 0) return { ok: false, n, reason: 'Charges identiques.' };
  const slope = sxy / sxx, intercept = my - slope * mx;
  if (slope >= 0) return { ok: false, n, reason: 'La vitesse ne diminue pas avec la charge : mesures incohérentes.' };
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  const e1rm = (mvt - intercept) / slope;
  const maxLoad = points[n - 1].load;
  const warnings = [];
  if (n === 2) warnings.push('Seulement 2 charges : estimation fragile, ajoute-en une 3e.');
  if (n >= 3 && r2 < 0.9) warnings.push('Les points ne sont pas alignés (R² ' + r2.toFixed(2) + ') : refais des reps propres.');
  if (e1rm > maxLoad * 1.35) warnings.push('1RM très au-dessus de ta charge max testée : monte plus lourd pour fiabiliser.');
  return { ok: true, n, slope, intercept, r2, e1rm, warnings };
}

export const loadForVelocity = (fit, v) => (v - fit.intercept) / fit.slope;
