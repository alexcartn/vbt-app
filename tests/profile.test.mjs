import { fitProfile, bestPerLoad, loadForVelocity, mvtNote } from '../js/profile.js';
// vitesses construites avec un vrai 1RM de 150 kg et une vitesse min de 0,30 : v = 1.20 - 0.006*charge
const sets = [60, 90, 110, 125].map(l => ({ load: l, reps: [{ mcv: 1.20 - 0.006 * l }, { mcv: 1.20 - 0.006 * l - 0.05 }] }));
const fit = fitProfile(bestPerLoad(sets), 0.30);
const ok = fit.ok && Math.abs(fit.e1rm - 150) < 0.5 && fit.r2 > 0.999 && Math.abs(loadForVelocity(fit, 0.6) - 100) < 0.5;
console.log(ok ? 'OK' : 'ECHEC', '1RM estimé', fit.e1rm.toFixed(1), 'R²', fit.r2.toFixed(3), '| charge à 0,6 m/s :', loadForVelocity(fit, 0.6).toFixed(1));
console.log('2 points ->', fitProfile([{load:60,v:.9},{load:100,v:.6}], .3).warnings[0]);
console.log('pente positive ->', fitProfile([{load:60,v:.5},{load:100,v:.9}], .3).reason);
const n = [mvtNote('squat', false), mvtNote('deadlift', false), mvtNote('bench', true)];
const ok2 = n[0] && n[0].includes('par défaut') && n[1] && n[1].includes('Deadlift') && n[1].toLowerCase().includes('individualise') && n[2] === null && mvtNote('deadlift', true) === null;
console.log(ok2 ? 'OK' : 'ECHEC', 'notes vitesse minimale :', n[0], '|', n[1]);
process.exit(ok && ok2 ? 0 : 1);
