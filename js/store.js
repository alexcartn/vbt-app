// Stockage local (localStorage) : séries enregistrées, profils, réglages.
import { MVT_DEFAULT } from './profile.js';

const KEY = 'vbt.v1';
export const DEFAULT_PROFILE_NAME = 'Alexandre';

// lossStop : perte de vitesse (0 à 1) qui déclenche l'alerte d'arrêt, 0 = désactivée
// rest : durée du repos en secondes après une série, 0 = pas de minuteur
// showRom : affiche l'amplitude (non validée) pour les tests de mesure
// guideSeen : le guide de démarrage a été lu (ou ignoré)
const SETTINGS_DEFAULT = { lossStop: 0.2, sound: true, rest: 0, showRom: false, guideSeen: false };
const empty = () => ({
  sets: [], mvt: { ...MVT_DEFAULT }, last: { exercise: 'squat', load: 60, target: null }, settings: { ...SETTINGS_DEFAULT },
  profiles: [], activeProfile: null
});

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Remet des données de n'importe quelle version au format courant : profils, vitesse minimale par profil, série -> profil. */
export function normalize(d) {
  const db = { ...empty(), ...d, mvt: { ...MVT_DEFAULT, ...(d.mvt || {}) }, settings: { ...SETTINGS_DEFAULT, ...(d.settings || {}) } };
  if (!Array.isArray(db.profiles) || !db.profiles.length) db.profiles = [{ id: 'p1', name: DEFAULT_PROFILE_NAME, mvt: { ...db.mvt }, mvtCustom: {} }];
  delete db.settings.voice;                               // la voix a été retirée
  db.profiles = db.profiles.map(p => ({ ...p, mvt: { ...MVT_DEFAULT, ...(p.mvt || {}) }, mvtCustom: { ...(p.mvtCustom || {}) } }));   // mvtCustom : vitesse minimale individualisée, par exercice
  if (!db.profiles.some(p => p.id === db.activeProfile)) db.activeProfile = db.profiles[0].id;
  db.sets = db.sets.map(s => (db.profiles.some(p => p.id === s.profileId) ? s : { ...s, profileId: db.profiles[0].id }));
  return db;
}

export function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.sets)) return normalize(d);
  } catch (_) { /* ignore */ }
  return normalize({});
}

export function save(db) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.warn('Stockage plein ou indisponible', e); }
}

export const dayKey = t => new Date(t).toLocaleDateString('sv-SE');   // AAAA-MM-JJ, en heure locale
