// Icônes des mouvements : traits fins, même style que la navigation (currentColor, bouts carrés).
const svg = body => `<svg class="exic" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="miter" stroke-linecap="square">${body}</svg>`;

const ICONS = {
  // squat : vue de face, barre sur les épaules, jambes fléchies
  squat: svg('<circle cx="12" cy="3.8" r="1.7"/><path d="M1.5 8h21"/><path d="M4 5v6M20 5v6"/><path d="M12 8.5v5"/><path d="M12 13.5l-4 3.2V21M12 13.5l4 3.2V21"/>'),
  // bench : vue de profil, allongé sur le banc, barre (disque vu de bout) au bout des bras
  bench: svg('<circle cx="9" cy="5" r="3"/><path d="M9 8.5v6"/><circle cx="4.8" cy="14" r="1.4"/><path d="M6.8 14.8h9.7l3 3V21"/><path d="M3 17.2h15M5 17.2v3.3M16 17.2v3.3"/>'),
  // deadlift : vue de profil, buste penché, barre au sol (disque vu de bout)
  deadlift: svg('<circle cx="4.8" cy="5.6" r="1.8"/><path d="M6.4 7.2l9 3.6M15.4 10.8l-3.4 5.2 1.8 5"/><path d="M6.8 7.8l.4 6.6"/><circle cx="7.2" cy="17.4" r="3"/><path d="M1.5 21.5h21"/>'),
  all: svg('<rect x="4" y="4" width="6.5" height="6.5"/><rect x="13.5" y="4" width="6.5" height="6.5"/><rect x="4" y="13.5" width="6.5" height="6.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5"/>')
};
export const exIcon = k => ICONS[k] || '';
