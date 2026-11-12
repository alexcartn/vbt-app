// Génère des données de capteur réalistes (mais simulées) pour tester sans matériel.
import { G } from './signal.js';

function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * reps : [{ mcv: vitesse moyenne de la montée en m/s, dur: durée de la montée en s }]
 * Renvoie { acc: [[x,y,z] en g], gyro: [[x,y,z] en °/s], truth: [{mcv, dur}] } à 100 Hz par défaut (option dt).
 * Le capteur est incliné de tiltDeg par rapport à la verticale, et peut osciller de swingDeg pendant la série.
 */
export function generateSet({ reps, restS = 1.2, pauseS = 0.8, eccS = 1.3, tiltDeg = 4, swingDeg = 0, noiseG = 0.01, biasG = 0, noiseDps = 0.3, seed = 1, dt = 0.01 }) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const v = [];                       // vitesse verticale vraie (m/s)
  const zeros = s => { for (let i = 0; i < Math.round(s / dt); i++) v.push(0); };
  const half = (peak, T, sign) => { const n = Math.round(T / dt); for (let i = 0; i < n; i++) v.push(sign * peak * Math.sin(Math.PI * (i + 0.5) / n)); };

  zeros(restS);
  for (const r of reps) {
    const D = r.mcv * r.dur;                       // amplitude de la montée
    half(Math.PI * D / (2 * eccS), eccS, -1);      // descente
    half(Math.PI * r.mcv / 2, r.dur, +1);          // montée
    zeros(pauseS);
  }
  zeros(restS);

  const acc = [], gyro = [];
  const tilt = i => (tiltDeg + swingDeg * Math.sin(2 * Math.PI * i * dt / 6)) * Math.PI / 180;
  for (let i = 0; i < v.length; i++) {
    const a = ((v[Math.min(i + 1, v.length - 1)] - v[Math.max(i - 1, 0)]) / (2 * dt)) / G;   // accélération verticale en g
    const th = tilt(i), dth = (tilt(i + 1) - tilt(i - 1)) / (2 * dt);
    const f = 1 + a;
    acc.push([gauss() * noiseG + biasG, Math.sin(th) * f + gauss() * noiseG + biasG, Math.cos(th) * f + gauss() * noiseG + biasG]);
    gyro.push([dth * 180 / Math.PI + gauss() * noiseDps, gauss() * noiseDps, gauss() * noiseDps]);
  }
  return { acc, gyro, truth: reps.map(r => ({ mcv: r.mcv, dur: r.dur })) };
}
