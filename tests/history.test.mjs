import { normalize } from '../js/store.js';
import { sessions, progress, loadsUsed, setSummary, repCount, repMaxes } from '../js/history.js';

let fails = 0;
const check = (name, cond, extra = '') => { if (!cond) fails++; console.log(cond ? 'OK   ' : 'ECHEC', name, extra); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

// ---------- migration : anciennes données sans profil ----------
const old = { sets: [{ id: 1, t: 1, exercise: 'squat', load: 100, reps: [] }], mvt: { squat: 0.28, bench: 0.17, deadlift: 0.15 }, last: { exercise: 'squat', load: 60 } };
let db = normalize(old);
check('migration : profil Alexandre créé', db.profiles.length === 1 && db.profiles[0].name === 'Alexandre');
check('migration : profil actif', db.activeProfile === db.profiles[0].id);
check('migration : séances rattachées à Alexandre', db.sets[0].profileId === db.profiles[0].id);
check('migration : vitesse minimale reprise dans le profil', db.profiles[0].mvt.squat === 0.28);
check('migration : idempotente', JSON.stringify(normalize(db)) === JSON.stringify(db));

db = normalize({ sets: [{ id: 1, t: 1, exercise: 'squat', load: 1, reps: [], profileId: 'fantome' }], profiles: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], activeProfile: 'zzz' });
check('profil actif inconnu -> premier profil', db.activeProfile === 'a');
check('série d\'un profil supprimé -> premier profil', db.sets[0].profileId === 'a');
check('profils sans mvt reçoivent les valeurs par défaut', db.profiles[1].mvt.bench === 0.17);

// ---------- séances et progression ----------
const day = n => new Date(2026, 10, n, 10, 0).getTime();
// v = 1.20 - 0.006*charge : vrai 1RM 150 kg à 0,30 m/s ; une séance plus forte le 8
const mk = (id, t, load, v, pid = 'a', failedExtra = false) => ({ id, t, exercise: 'squat', load, profileId: pid, reps: [{ mcv: v }, { mcv: v - 0.05 }, ...(failedExtra ? [{ mcv: 9, failed: true }] : [])] });
const sets = [
  mk(1, day(2), 60, 0.84), mk(2, day(2) + 1e6, 90, 0.66), mk(3, day(2) + 2e6, 120, 0.48),
  mk(4, day(8), 60, 0.90), mk(5, day(8) + 1e6, 90, 0.72), mk(6, day(8) + 2e6, 120, 0.54, 'a', true),
  mk(7, day(5), 60, 0.50, 'b'),                                           // autre profil
  { ...mk(8, day(5), 60, 0.5), exercise: 'bench' }                        // autre exercice
];
const ses = sessions(sets, 'squat', 'a', { squat: 0.30, bench: 0.17, deadlift: 0.15 });
check('2 séances pour Alexandre en squat', ses.length === 2, `n=${ses.length}`);
check('séances triées par date croissante', ses[0].day < ses[1].day);
check('séries triées dans la séance', ses[0].sets.map(s => s.id).join() === '1,2,3');
check('1RM de la séance 1 ≈ 150', ses[0].e1rm != null && Math.abs(ses[0].e1rm - 150) < 1, `e1rm=${ses[0].e1rm}`);
check('la séance 2 est plus forte', ses[1].e1rm > ses[0].e1rm, `${ses[1].e1rm}`);
check('volume = charge × reps valides', ses[0].volume === 60 * 2 + 90 * 2 + 120 * 2 && ses[1].volume === 60 * 2 + 90 * 2 + 120 * 2, `${ses[0].volume}/${ses[1].volume}`);
check('séance avec 1 seule charge : pas de 1RM', sessions([mk(9, day(3), 60, 0.8)], 'squat', 'a', { squat: 0.3 })[0].e1rm === null);

const p1 = progress(ses, 'e1rm');
check('progression 1RM : 2 points', p1.length === 2 && p1[1].v > p1[0].v);
const p2 = progress(ses, 'vel', 90);
check('progression vitesse à 90 kg', p2.length === 2 && near(p2[0].v, 0.66) && near(p2[1].v, 0.72));
check('vitesse à une charge absente : aucun point', progress(ses, 'vel', 100).length === 0);
check('charges utilisées, la plus fréquente d\'abord', loadsUsed(ses).length === 3 && loadsUsed(ses).every(l => [60, 90, 120].includes(l)));
check('charges : égalité -> la plus légère d\'abord', loadsUsed(ses)[0] === 60);

// ---------- résumé d'une série ----------
const sm = setSummary({ reps: [{ mcv: 0.8 }, { mcv: 0.72 }, { mcv: 0.64 }, { mcv: 0.2, failed: true }] });
check('résumé : 3 reps valides, 1 ratée', sm.n === 3 && sm.failed === 1);
check('résumé : meilleure, moyenne, perte', near(sm.best, 0.8) && near(sm.mean, 0.72) && near(sm.loss, 0.2), JSON.stringify(sm));
const empty = setSummary({ reps: [] });
check('résumé d\'une série vide', empty.n === 0 && empty.best === 0 && empty.loss === 0);


// ---------- série saisie à la main (sans capteur) ----------
const manual = { id: 50, t: day(8) + 3e6, exercise: 'squat', load: 100, profileId: 'a', manual: true, count: 5, reps: [] };
check('repCount : série manuelle', repCount(manual) === 5);
check('repCount : reps valides seulement', repCount({ reps: [{ mcv: 1 }, { mcv: 1, failed: true }] }) === 1);
const sm2 = setSummary(manual);
check('résumé manuel : 5 reps, sans vitesse', sm2.n === 5 && sm2.manual === true && sm2.best === 0 && sm2.mean === 0);
const ses2 = sessions([...sets, manual], 'squat', 'a', { squat: 0.30 });
check('volume compte la série manuelle', ses2[1].volume === 540 + 100 * 5 && ses2[1].nReps === 6 + 5, `${ses2[1].volume}/${ses2[1].nReps}`);
check('le 1RM du jour ignore la série manuelle', near(ses2[1].e1rm, ses[1].e1rm));
check('progression vitesse ignore la série manuelle', progress(ses2, 'vel', 100).length === 0);

// ---------- records par nombre de reps ----------
const rs = [
  { id: 1, t: 1000, exercise: 'squat', load: 100, profileId: 'a', reps: [0.7, 0.68, 0.66, 0.6, 0.55].map(v => ({ mcv: v })) },   // 5 reps à 100
  { id: 2, t: 2000, exercise: 'squat', load: 120, profileId: 'a', reps: [0.5, 0.45, 0.4].map(v => ({ mcv: v })) },              // 3 reps à 120
  { id: 3, t: 3000, exercise: 'squat', load: 140, profileId: 'a', reps: [{ mcv: 0.32 }] },                                      // 1 rep à 140
  { id: 4, t: 4000, exercise: 'squat', load: 110, profileId: 'a', manual: true, count: 5, reps: [] },                           // 5 reps à 110, sans capteur
  { id: 5, t: 5000, exercise: 'squat', load: 150, profileId: 'a', reps: [{ mcv: 0.3 }, { mcv: 0.1, failed: true }] },           // 2e rep ratée : compte pour 1
  { id: 6, t: 6000, exercise: 'squat', load: 200, profileId: 'b', reps: [{ mcv: 0.3 }] },                                       // autre profil
  { id: 7, t: 7000, exercise: 'bench', load: 300, profileId: 'a', reps: [{ mcv: 0.3 }] }                                        // autre exercice
];
const rm = repMaxes(rs, 'squat', 'a');
const byN = Object.fromEntries(rm.map(x => [x.n, x]));
check('records : 1RM = 150 (rep ratée non comptée dans la 2e)', byN[1].load === 150 && byN[1].setId === 5, JSON.stringify(byN[1]));
check('records : 2RM = 120', byN[2].load === 120 && byN[2].setId === 2);
check('records : 3RM = 120', byN[3].load === 120);
check('records : 4RM = 110 (série manuelle)', byN[4].load === 110 && byN[4].manual === true && byN[4].v === null);
check('records : 5RM = 110', byN[5].load === 110);
check('records : profil et exercice respectés', rm.every(x => x.load < 200) && rm.length === 5);
check('records : vitesse moyenne de la série', near(byN[3].v, (0.5 + 0.45 + 0.4) / 3));
check('records : égalité de charge -> la plus récente', repMaxes([{ id: 1, t: 1, exercise: 'squat', load: 100, profileId: 'a', reps: [{ mcv: 0.5 }] }, { id: 2, t: 2, exercise: 'squat', load: 100, profileId: 'a', reps: [{ mcv: 0.6 }] }], 'squat', 'a')[0].setId === 2);
check('records : aucun -> liste vide', repMaxes([], 'squat', 'a').length === 0);
check('records : pas de 5RM sans série de 5 reps', repMaxes([rs[2]], 'squat', 'a').length === 1);

console.log(fails ? `${fails} échec(s)` : 'Tout est OK');
process.exit(fails ? 1 : 0);
