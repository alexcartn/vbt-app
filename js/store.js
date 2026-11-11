// Stockage local (localStorage) : séries enregistrées + réglages.
import { MVT_DEFAULT } from './profile.js';

const KEY = 'vbt.v1';
const empty = () => ({ sets: [], mvt: { ...MVT_DEFAULT }, last: { exercise: 'squat', load: 60 } });

export function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.sets)) return { ...empty(), ...d, mvt: { ...MVT_DEFAULT, ...(d.mvt || {}) } };
  } catch (_) { /* ignore */ }
  return empty();
}

export function save(db) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.warn('Stockage plein ou indisponible', e); }
}

export const dayKey = t => new Date(t).toLocaleDateString('sv-SE');   // AAAA-MM-JJ, en heure locale
