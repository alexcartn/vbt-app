// Connexion Web Bluetooth au MetaMotion MMS (protocole relevé dans MetaWear-SDK-Cpp).
const SERVICE = '326a9000-85cb-9195-d9dd-464cfbbae75a';
const CHAR_CMD = '326a9001-85cb-9195-d9dd-464cfbbae75a';
const CHAR_NOTIFY = '326a9006-85cb-9195-d9dd-464cfbbae75a';
const MOD_ACC = 0x03, MOD_GYRO = 0x13;
const ACC_RANGE = 2;                 // 1 = ±4 g, 2 = ±8 g, 3 = ±16 g
const ACC_SCALE = { 1: 8192, 2: 4096, 3: 2048 };   // LSB par g
const GYRO_SCALE = 16.4;             // LSB par °/s à ±2000 °/s

export const bleSupported = () => !!navigator.bluetooth;

export class Sensor {
  /** handlers : { onAcc([x,y,z] en g), onGyro([x,y,z] en °/s), onStatus(texte, ok), onDisconnect() } */
  constructor(handlers) { this.h = handlers; this.device = null; this.cmd = null; }

  async _send(bytes) {
    const d = new Uint8Array(bytes);
    if (this.cmd.writeValueWithoutResponse) await this.cmd.writeValueWithoutResponse(d); else await this.cmd.writeValue(d);
    await new Promise(r => setTimeout(r, 30));
  }

  _onNotify = ev => {
    const dv = ev.target.value;
    if (dv.byteLength < 8 || dv.getUint8(1) !== 0x04) return;
    const x = dv.getInt16(2, true), y = dv.getInt16(4, true), z = dv.getInt16(6, true), mod = dv.getUint8(0);
    if (mod === MOD_ACC) this.h.onAcc([x / ACC_SCALE[ACC_RANGE], y / ACC_SCALE[ACC_RANGE], z / ACC_SCALE[ACC_RANGE]]);
    else if (mod === MOD_GYRO) this.h.onGyro([x / GYRO_SCALE, y / GYRO_SCALE, z / GYRO_SCALE]);
  };

  async connect() {
    this.h.onStatus('Recherche du capteur...', false);
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE] }, { namePrefix: 'MetaWear' }],
      optionalServices: [SERVICE]
    });
    this.device.addEventListener('gattserverdisconnected', () => this.h.onDisconnect());
    this.h.onStatus('Connexion...', false);
    const server = await Promise.race([
      this.device.gatt.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Le capteur ne répond pas. Appuie sur son bouton puis réessaie.')), 15000))
    ]);
    const svc = await server.getPrimaryService(SERVICE);
    this.cmd = await svc.getCharacteristic(CHAR_CMD);
    const notify = await svc.getCharacteristic(CHAR_NOTIFY);
    notify.addEventListener('characteristicvaluechanged', this._onNotify);
    await notify.startNotifications();
    // Accéléromètre BMI270 : 100 Hz, plage choisie. Gyroscope : 100 Hz, ±2000 °/s.
    await this._send([MOD_ACC, 0x03, 0xA8, ACC_RANGE]);
    await this._send([MOD_ACC, 0x04, 0x01]);
    await this._send([MOD_ACC, 0x02, 0x01, 0x00]);
    await this._send([MOD_ACC, 0x01, 0x01]);
    await this._send([MOD_GYRO, 0x03, 0x28, 0x00]);
    await this._send([MOD_GYRO, 0x04, 0x01]);
    await this._send([MOD_GYRO, 0x02, 0x01, 0x00]);
    await this._send([MOD_GYRO, 0x01, 0x01]);
    this.h.onStatus('Connecté', true);
  }

  async disconnect() {
    try {
      for (const m of [MOD_ACC, MOD_GYRO]) { await this._send([m, 0x01, 0x00]); await this._send([m, 0x02, 0x00, 0x01]); await this._send([m, 0x04, 0x00]); }
    } catch (_) { /* déjà déconnecté */ }
    try { this.device && this.device.gatt.connected && this.device.gatt.disconnect(); } catch (_) { /* ignore */ }
  }
}
