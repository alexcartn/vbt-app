// Données d'exemple pour la démo (?demo=1) : un profil actif, 8 semaines de séances sur les 3 mouvements.
// Aucune de ces données n'est enregistrée dans le vrai historique : la démo a son propre stockage.
const MVT = { squat: 0.30, bench: 0.17, deadlift: 0.15 };
// 1RM de départ -> d'arrivée (kg), pente charge-vitesse (m/s par kg), jours (avant aujourd'hui) des séances
const PLAN = {
  squat:    { e0: 118, e1: 134, slope: 0.0085, days: [0, 3, 7, 10, 14, 17, 21, 24, 28, 31, 35, 38, 42, 45, 49, 52] },
  bench:    { e0: 82,  e1: 91,  slope: 0.0155, days: [1, 5, 8, 12, 15, 19, 22, 26, 29, 33, 36, 40] },
  deadlift: { e0: 150, e1: 168, slope: 0.0064, days: [2, 9, 16, 23, 30, 37, 44] }
};

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const rep = (v, failed) => {
  const peak = +(v * 1.55).toFixed(3);
  const r = { mcv: +v.toFixed(3), peak, dur: +(0.62 / v).toFixed(2), rom: 0.55, curve: Array.from({ length: 40 }, (_, i) => +(Math.sin((i / 39) * Math.PI) * peak).toFixed(3)) };
  if (failed) r.failed = true;
  return r;
}

export function demoData(now = Date.now()) {
  const rand = rng(7), sets = [], profileId = 'demo';
  let id = 1;
  for (const [exercise, plan] of Object.entries(PLAN)) {
    for (const off of plan.days) {
      const d = new Date(now); d.setDate(d.getDate() - off); d.setHours(18, 0, 0, 0);
      const e1rm = plan.e0 + (plan.e1 - plan.e0) * (1 - off / 56);
      const vAt = load => MVT[exercise] + (e1rm - load) * plan.slope;
      const round = x => Math.round(x / 2.5) * 2.5;
      const plan_ = [[0.45, 3], [0.6, 3], [0.75, 3], [0.85, 2]];
      if (exercise !== 'deadlift') plan_.push([0.72, 5]);   // série de travail : perte de vitesse visible
      plan_.forEach(([frac, n], i) => {
        const load = round(e1rm * frac), base = vAt(load) * (1 + (rand() - 0.5) * 0.07);
        const decay = n === 5 ? 0.045 : 0.025;
        const reps = Array.from({ length: n }, (_, k) => rep(base * (1 - decay * k) * (1 + (rand() - 0.5) * 0.02), off === 12 && frac === 0.72 && k === 4));
        sets.push({ id: id++, t: d.getTime() + i * 240000, exercise, load, profileId, ...(n === 5 ? { target: 0.6 } : {}), reps });
      });
    }
  }
  return {
    sets, mvt: { ...MVT }, last: { exercise: 'squat', load: 100, target: null },
    settings: { lossStop: 0.2, sound: true, rest: 0, showRom: false, guideSeen: true },
    profiles: [{ id: profileId, name: 'Camille', mvt: { ...MVT }, mvtCustom: {} }], activeProfile: profileId
  };
}
