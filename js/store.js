// Stockage local (localStorage) : séries enregistrées + réglages.
import { MVT_DEFAULT } from './profile.js';

const KEY = 'vbt.v1';
// lossStop : perte de vitesse (0 à 1) qui déclenche l'alerte d'arrêt, 0 = désactivée
const SETTINGS_DEFAULT = { lossStop: 0.2, sound: true, voice: false };
const empty = () => ({ sets: [], mvt: { ...MVT_DEFAULT }, last: { exercise: 'squat', load: 60 }, settings: { ...SETTINGS_DEFAULT } });

export function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.sets)) return { ...empty(), ...d, mvt: { ...MVT_DEFAULT, ...(d.mvt || {}) }, settings: { ...SETTINGS_DEFAULT, ...(d.settings || {}) } };
  } catch (_) { /* ignore */ }
  return empty();
}

export function save(db) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.warn('Stockage plein ou indisponible', e); }
}

export const dayKey = t => new Date(t).toLocaleDateString('sv-SE');   // AAAA-MM-JJ, en heure locale
