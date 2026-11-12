// Lance avec : node tests/signal.test.mjs
import { Tracker } from '../js/signal.js';
import { generateSet } from '../js/sim.js';

const REPS = [{ mcv: 0.80, dur: 0.70 }, { mcv: 0.74, dur: 0.78 }, { mcv: 0.66, dur: 0.88 }, { mcv: 0.58, dur: 1.00 }, { mcv: 0.47, dur: 1.25 }];
const scenarios = [
  { name: 'capteur incliné 4°, bruit normal', opts: {} },
  { name: 'oscillation de la barre ±3°', opts: { swingDeg: 3 } },
  { name: 'biais accéléro 0,02 g', opts: { biasG: 0.02 } },
  { name: 'bruit élevé (0,015 g)', opts: { noiseG: 0.015 } },
  { name: 'inclinaison 25° + oscillation 5°', opts: { tiltDeg: 25, swingDeg: 5 } },
  { name: 'téléphone 60 Hz', opts: { dt: 1 / 60 }, hz: 60 },
  { name: 'téléphone 60 Hz, bruit élevé, oscillation', opts: { dt: 1 / 60, noiseG: 0.015, noiseDps: 0.5, swingDeg: 3, tiltDeg: 15 }, hz: 60 },
  { name: 'téléphone 50 Hz', opts: { dt: 1 / 50 }, hz: 50 },
  { name: 'charge lourde, lente (0,25 m/s)', opts: {}, reps: [{ mcv: 0.28, dur: 1.9 }, { mcv: 0.25, dur: 2.1 }] },
];

let worst = 0, failed = 0;
for (const sc of scenarios) {
  const reps = sc.reps || REPS;
  const sim = generateSet({ reps, ...sc.opts });
  const t = new Tracker();
  if (sc.hz) t.setDt(1 / sc.hz);
  const found = [];
  for (let i = 0; i < sim.acc.length; i++) found.push(...t.push(sim.acc[i], sim.gyro[i]));
  found.push(...t.flush());
  const errs = reps.map((r, i) => found[i] ? Math.abs(found[i].mcv - r.mcv) : NaN);
  const ok = found.length === reps.length && errs.every(e => e < 0.05);
  if (!ok) failed++;
  worst = Math.max(worst, ...errs.filter(e => !isNaN(e)));
  console.log(`${ok ? 'OK  ' : 'ECHEC'} ${sc.name}: ${found.length}/${reps.length} reps | vraies ${reps.map(r => r.mcv.toFixed(2)).join(' ')} | mesurées ${found.map(f => f.mcv.toFixed(2)).join(' ')}`);
}
console.log(`\nPire erreur de vitesse moyenne : ${worst.toFixed(3)} m/s | scénarios en échec : ${failed}/${scenarios.length}`);
process.exit(failed ? 1 : 0);
