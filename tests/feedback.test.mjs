import { activeReps, setStats, shouldStop, rawCsv } from '../js/feedback.js';
import { bestPerLoad } from '../js/profile.js';

let fails = 0;
const check = (name, cond, extra = '') => { if (!cond) fails++; console.log(cond ? 'OK   ' : 'ECHEC', name, extra); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

const R = (mcv, failed) => ({ mcv, ...(failed ? { failed: true } : {}) });

// reps actives : on écarte les reps ratées
check('activeReps écarte les ratées', activeReps([R(0.8), R(0.3, true), R(0.7)]).length === 2);

// perte de vitesse : dernière rep active contre meilleure rep active
let st = setStats([R(0.80), R(0.76), R(0.64)]);
check('perte = (0,80-0,64)/0,80 = 20 %', near(st.loss, 0.2) && st.best === 0.80 && st.last.mcv === 0.64, `loss=${st.loss}`);
st = setStats([R(0.80)]);
check('1 rep : perte nulle', st.loss === 0);
st = setStats([]);
check('aucune rep : pas de dernière rep', st.last === null && st.loss === 0 && st.best === 0);
st = setStats([R(0.80), R(0.50, true)]);
check('une rep ratée ne compte pas dans la perte', st.loss === 0 && st.last.mcv === 0.80);
st = setStats([R(0.60), R(0.90)]);
check('rep plus rapide que la précédente : perte nulle', st.loss === 0 && st.best === 0.90);

// seuil d'arrêt
check('seuil désactivé (0)', shouldStop([R(0.8), R(0.4)], 0) === false);
check('sous le seuil', shouldStop([R(0.8), R(0.68)], 0.2) === false);   // 15 %
check('au seuil exact', shouldStop([R(0.8), R(0.64)], 0.2) === true);   // 20 %
check('au-dessus du seuil', shouldStop([R(0.8), R(0.5)], 0.2) === true);
check('une seule rep ne déclenche jamais', shouldStop([R(0.8)], 0.1) === false);

// profil : une rep ratée ne doit pas fixer la meilleure vitesse d'une charge
const pts = bestPerLoad([{ load: 100, reps: [R(0.60), R(1.40, true)] }]);
check('bestPerLoad ignore les reps ratées', pts.length === 1 && near(pts[0].v, 0.60), JSON.stringify(pts));
check('série entièrement ratée ignorée', bestPerLoad([{ load: 100, reps: [R(0.3, true)] }]).length === 0);

// export CSV brut : en-tête commenté + une ligne par échantillon
const csv = rawCsv([[0, 0.01, -0.02, 1.0, 1, 2, 3], [1, 0, 0, 1.0, 0, 0, 0]], { exercise: 'squat', load: 100, hz: 99.5, t: Date.UTC(2026, 10, 11, 12, 0, 0) });
const lines = csv.trim().split('\n');
check('CSV : méta + en-tête + 2 lignes', lines.length === 5 && lines[0].startsWith('# ') && lines[2] === 'i,ax,ay,az,gx,gy,gz' && lines[3] === '0,0.01,-0.02,1,1,2,3', lines.join(' | '));
check('CSV : méta contient la fréquence', lines[0].includes('hz=99.5') && lines[1].includes('squat') && lines[1].includes('100'));

console.log(fails ? `${fails} échec(s)` : 'Tout est OK');
process.exit(fails ? 1 : 0);
