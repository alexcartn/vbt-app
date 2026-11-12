// Capteurs du téléphone (accéléromètre + gyroscope) : même interface que Sensor dans ble.js.
// Chrome Android : Generic Sensor API (Accelerometer, Gyroscope), gravité incluse, m/s² et rad/s.
// Repli : devicemotion (iOS Safari, ou Chrome sans Generic Sensor). Le repli iOS n'a pas été testé sur un vrai appareil.
const G = 9.81, RAD = 180 / Math.PI;
const FREQ = 100;   // demandé ; Chrome plafonne en général à 60 Hz, la fréquence réelle est mesurée par l'app

export const phoneSupported = () => 'Accelerometer' in window && 'Gyroscope' in window || 'DeviceMotionEvent' in window;

export class PhoneSensor {
  /** handlers : { onAcc([x,y,z] en g), onGyro([x,y,z] en °/s), onStatus(texte, ok), onDisconnect() } */
  constructor(handlers) { this.h = handlers; this.sensors = []; this.motion = null; this.api = ''; }

  async connect() {
    this.h.onStatus('Démarrage des capteurs...', false);
    if ('Accelerometer' in window && 'Gyroscope' in window) {
      try { await this._startGeneric(); this.api = 'Generic Sensor'; this.h.onStatus('Connecté', true); return; }
      catch (e) { this._stop(); if (!('DeviceMotionEvent' in window)) throw e; }
    }
    await this._startMotion();
    this.api = 'devicemotion';
    this.h.onStatus('Connecté', true);
  }

  async _startGeneric() {
    for (const name of ['accelerometer', 'gyroscope']) {
      try { const p = await navigator.permissions.query({ name }); if (p.state === 'denied') throw new Error('Capteurs de mouvement refusés : autorise-les dans les réglages du site.'); }
      catch (e) { if (/refusés/.test(e.message)) throw e; }
    }
    const acc = new Accelerometer({ frequency: FREQ }), gyr = new Gyroscope({ frequency: FREQ });
    acc.addEventListener('reading', () => this.h.onAcc([acc.x / G, acc.y / G, acc.z / G]));
    gyr.addEventListener('reading', () => this.h.onGyro([gyr.x * RAD, gyr.y * RAD, gyr.z * RAD]));
    this.sensors = [acc, gyr];
    await Promise.all(this.sensors.map(s => new Promise((res, rej) => {
      s.addEventListener('activate', res, { once: true });
      s.addEventListener('error', ev => { rej(new Error(ev.error && ev.error.name === 'NotAllowedError' ? 'Capteurs de mouvement refusés.' : (ev.error && ev.error.message) || 'Capteur indisponible')); }, { once: true });
      s.start();
      setTimeout(() => rej(new Error('Les capteurs ne répondent pas.')), 4000);
    })));
    this.sensors.forEach(s => s.addEventListener('error', () => this.h.onDisconnect()));
  }

  async _startMotion() {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {   // iOS : doit être appelé depuis un geste de l'utilisateur
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('Capteurs de mouvement refusés.');
    }
    // iOS donne la gravité avec le signe opposé à Android
    const sign = /iP(hone|ad|od)/.test(navigator.userAgent) ? -1 : 1;
    let got = false;
    this.motion = ev => {
      const a = ev.accelerationIncludingGravity, r = ev.rotationRate;
      if (!a || a.x == null || !r || r.alpha == null) return;
      got = true;
      this.h.onGyro([r.beta, r.gamma, r.alpha]);
      this.h.onAcc([sign * a.x / G, sign * a.y / G, sign * a.z / G]);
    };
    window.addEventListener('devicemotion', this.motion);
    await new Promise((res, rej) => setTimeout(() => got ? res() : rej(new Error('Aucune donnée de mouvement reçue.')), 1500));
  }

  _stop() {
    this.sensors.forEach(s => { try { s.stop(); } catch (_) { /* déjà arrêté */ } });
    this.sensors = [];
    if (this.motion) { window.removeEventListener('devicemotion', this.motion); this.motion = null; }
  }

  async disconnect() { this._stop(); }
}
