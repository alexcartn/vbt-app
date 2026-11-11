// Calcul de la vitesse de la barre à partir de l'accéléromètre + gyroscope (100 Hz).
// Principe :
//  1. Calibrage au repos : la direction de la gravité dans le repère du capteur donne le "haut",
//     quelle que soit la façon dont le capteur est fixé sur la barre.
//  2. La direction du "haut" est suivie avec le gyroscope pendant le mouvement.
//  3. Accélération verticale = projection de l'accélération sur le "haut", moins 1 g.
//  4. Entre deux moments d'immobilité, on intègre l'accélération pour obtenir la vitesse,
//     puis on enlève la dérive linéaire (la vitesse vraie vaut 0 au début et à la fin du segment).
//  5. Chaque phase de vitesse positive (montée) est une répétition : vitesse moyenne, pic, durée, amplitude.

export const G = 9.81;
const DEG = Math.PI / 180;

export const DEFAULTS = {
  dt: 0.01,            // 100 Hz
  calibSamples: 50,    // 0,5 s immobile pour le calibrage
  quietWindow: 12,     // 120 ms sans mouvement = "immobile"
  quietLong: 100,      // 1 s sans mouvement : fin de segment même si la vitesse estimée a dérivé
  vEnd: 0.15,          // m/s : vitesse estimée max pour accepter une fin de segment
  accTol: 0.035,       // g : écart de |a| à 1 g toléré en immobilité (assez serré pour les reps lentes)
  gyroTol: 20,         // °/s toléré en immobilité
  realignK: 0.05,      // correction douce du "haut" quand c'est parfaitement immobile
  minSegS: 0.4,
  maxSegS: 25,
  vTrim: 0.03,         // m/s : on ignore les bords de la montée sous ce seuil
  peakMin: 0.15,       // m/s : pic minimum pour compter une rep
  durMin: 0.25,        // s
  romMin: 0.12,        // m : amplitude minimum
  curvePoints: 40
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = a => Math.hypot(a[0], a[1], a[2]);
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const unit = a => scale(a, 1 / (norm(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class Tracker {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.reset();
  }

  setDt(dt) { this.o.dt = dt; }

  reset() {
    this.state = 'calib';   // 'calib' -> 'idle' <-> 'moving'
    this.calib = [];
    this.up = null;
    this.ref = 1;           // niveau mesuré au repos (inclut le décalage de zéro du capteur)
    this.quietRun = 0;
    this.pre = [];
    this.seg = [];
    this.vRun = 0;
  }

  /** a = [x,y,z] en g, w = [x,y,z] en °/s. Renvoie les reps terminées avec ce échantillon. */
  push(a, w) {
    const o = this.o;
    if (this.state === 'calib') return this._calibrate(a);

    // 1. suivi du "haut" avec le gyroscope : un vecteur fixe dans le monde tourne à -ω dans le repère du capteur
    const wr = scale(w, DEG);
    this.up = unit([
      this.up[0] - cross(wr, this.up)[0] * o.dt,
      this.up[1] - cross(wr, this.up)[1] * o.dt,
      this.up[2] - cross(wr, this.up)[2] * o.dt
    ]);

    const mag = norm(a), devAcc = Math.abs(mag - this.ref), wn = norm(w);
    const quiet = devAcc < o.accTol && wn < o.gyroTol;
    this.quietRun = quiet ? this.quietRun + 1 : 0;

    // 2. recalage doux quand le capteur est parfaitement immobile
    if (devAcc < 0.03 && wn < 10) {
      const m = unit(a), k = o.realignK;
      this.up = unit([this.up[0] * (1 - k) + m[0] * k, this.up[1] * (1 - k) + m[1] * k, this.up[2] * (1 - k) + m[2] * k]);
    }

    // 3. accélération verticale en m/s²
    const aVert = (dot(a, this.up) - this.ref) * G;

    if (this.state === 'idle') {
      this.pre.push(aVert);
      if (this.pre.length > 40) this.pre.shift();
      if (!quiet) {
        this.state = 'moving';
        this.seg = this.pre.slice();
        this.vRun = this.seg.reduce((t, x) => t + x * o.dt, 0);
        this.pre = [];
        this.quietRun = 0;
      }
      return [];
    }

    // state === 'moving'
    this.seg.push(aVert);
    this.vRun += aVert * o.dt;
    const stopped = this.quietRun >= o.quietWindow && Math.abs(this.vRun) < o.vEnd;
    if (stopped || this.quietRun >= o.quietLong) {
      const seg = this.seg.slice(0, this.seg.length - this.quietRun + 2);
      this.seg = []; this.state = 'idle'; this.pre = [];
      return this._process(seg);
    }
    if (this.seg.length * o.dt > o.maxSegS) { this.seg = []; this.state = 'idle'; this.pre = []; }
    return [];
  }

  /** À appeler en fin de série : traite le segment en cours (la barre n'est peut-être pas détectée immobile). */
  flush() {
    if (this.state !== 'moving') return [];
    const seg = this.seg.slice(0, Math.max(0, this.seg.length - this.quietRun + 2));
    this.seg = []; this.state = 'idle'; this.pre = [];
    return this._process(seg);
  }

  _calibrate(a) {
    const o = this.o;
    this.calib.push(a);
    if (this.calib.length < o.calibSamples) return [];
    const mean = [0, 0, 0];
    for (const s of this.calib) { mean[0] += s[0]; mean[1] += s[1]; mean[2] += s[2]; }
    const m = scale(mean, 1 / this.calib.length);
    // le capteur doit être immobile : chaque échantillon proche de la moyenne
    const still = this.calib.every(s => norm([s[0] - m[0], s[1] - m[1], s[2] - m[2]]) < 0.12) && Math.abs(norm(m) - 1) < 0.2;
    if (!still) { this.calib = []; return []; }
    this.up = unit(m);
    this.ref = norm(m);
    this.state = 'idle';
    return [];
  }

  _process(seg) {
    const o = this.o, n = seg.length;
    if (n * o.dt < o.minSegS) return [];

    // intégration (trapèzes) puis retrait de la dérive linéaire
    const v = new Float64Array(n);
    let acc = 0;
    for (let i = 1; i < n; i++) { acc += 0.5 * (seg[i] + seg[i - 1]) * o.dt; v[i] = acc; }
    const drift = v[n - 1];
    for (let i = 0; i < n; i++) v[i] -= drift * i / (n - 1);

    // phases de vitesse positive (en fusionnant les trous de 3 échantillons ou moins)
    const runs = [];
    let i = 0;
    while (i < n) {
      if (v[i] > o.vTrim) {
        let s = i;
        while (i < n && v[i] > 0) i++;
        let e = i;
        const last = runs[runs.length - 1];
        if (last && s - last[1] <= 3) last[1] = e; else runs.push([s, e]);
      } else i++;
    }

    const reps = [];
    for (let [s, e] of runs) {
      while (s < e && v[s] < o.vTrim) s++;
      while (e > s && v[e - 1] < o.vTrim) e--;
      const len = e - s;
      if (len < 2) continue;
      let sum = 0, peak = 0;
      for (let k = s; k < e; k++) { sum += v[k]; if (v[k] > peak) peak = v[k]; }
      const dur = len * o.dt, rom = sum * o.dt, mcv = sum / len;
      if (peak < o.peakMin || dur < o.durMin || rom < o.romMin) continue;
      const curve = [];
      for (let c = 0; c < o.curvePoints; c++) {
        const f = s + (c / (o.curvePoints - 1)) * (len - 1), lo = Math.floor(f), hi = Math.min(e - 1, lo + 1);
        curve.push(+(v[lo] + (v[hi] - v[lo]) * (f - lo)).toFixed(3));
      }
      reps.push({ mcv: +mcv.toFixed(3), peak: +peak.toFixed(3), dur: +dur.toFixed(2), rom: +rom.toFixed(3), curve });
    }
    return reps;
  }
}
