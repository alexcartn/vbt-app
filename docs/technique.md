# Description technique

## Vue d'ensemble

Application web progressive en JavaScript natif (modules ES), sans dépendance, sans build, sans backend. Tout tourne dans le navigateur : acquisition des capteurs, calcul, stockage (localStorage) et interface. Environ 1 400 lignes de JS.

```
Capteur (MetaMotion via Web Bluetooth, ou téléphone via Generic Sensor / devicemotion)
        │  accélération (g) + vitesse angulaire (°/s), ~100 Hz (60 Hz sur téléphone)
        ▼
   signal.js  : Tracker (calibrage, orientation, intégration, détection des reps)
        ▼
   feedback.js / profile.js : perte de vitesse, profil charge-vitesse, 1RM estimé
        ▼
   app.js / history.js / store.js : interface, historique, localStorage
```

## Modules

| Fichier | Rôle |
|---|---|
| `js/signal.js` | Calcul de la vitesse par rep (cœur de l'app) |
| `js/ble.js` | Protocole MetaWear en Web Bluetooth (BMI270 accéléromètre + gyroscope) |
| `js/phone.js` | Capteurs du téléphone (Generic Sensor API, repli `devicemotion`) |
| `js/profile.js` | Régression charge-vitesse, 1RM estimé, vitesse minimale |
| `js/feedback.js` | Perte de vitesse, seuil d'arrêt, minuteur de repos, vitesse cible, export CSV |
| `js/history.js` | Records par nombre de reps, séries du jour, courbes de progression |
| `js/store.js` | Persistance locale, migration des données, profils |
| `js/audio.js` | Bips Web Audio |
| `js/sim.js`, `js/demo.js` | Simulation de mouvements pour les tests, données de démo |
| `sw.js` | Service worker : hors ligne, mise à jour contrôlée par l'utilisateur |

## Algorithme de vitesse

Le capteur peut être fixé dans n'importe quelle orientation sur la barre. Le calcul est donc indépendant du repère du capteur.

1. Calibrage au repos (0,5 s) : la direction de la gravité mesurée donne le « haut » dans le repère du capteur, et le niveau de repos de |a| absorbe le décalage de zéro.
2. Suivi de l'orientation : le « haut » est mis à jour avec le gyroscope pendant le mouvement, puis recalé doucement quand le capteur est parfaitement immobile.
3. Accélération verticale : projection de l'accélération sur le « haut », moins 1 g.
4. Intégration entre deux immobilités : détection d'immobilité (fenêtre de 120 ms, tolérances sur |a| et sur le gyroscope), intégration de l'accélération en vitesse, puis suppression de la dérive linéaire (la vitesse vraie est nulle au début et à la fin du segment). C'est une correction de type ZUPT (zero velocity update).
5. Découpage en reps : chaque phase de vitesse positive (montée) est une rep, avec rejet des artefacts (pic minimal 0,15 m/s, durée minimale 0,25 s, amplitude minimale 12 cm).
6. Sorties par rep : vitesse moyenne de la montée, pic, durée, courbe de vitesse (40 points). Les durées exprimées en échantillons sont ramenées à la fréquence réelle du capteur (`Tracker.setDt`), mesurée à 60 Hz sur un Android.

## Profil charge-vitesse et 1RM

- Meilleure vitesse moyenne par charge (reps ratées exclues)
- Régression linéaire vitesse = a + b × charge, avec R² et avertissements (2 charges seulement, points non alignés, extrapolation trop lointaine)
- 1RM estimé : charge où la droite atteint la vitesse minimale (vitesse de la dernière rep réussie). Valeurs par défaut de la littérature (squat 0,30, bench 0,17, deadlift 0,15 m/s), individualisables à partir de la vitesse à l'échec de l'utilisateur

## Web Bluetooth (MetaMotion MMS)

Protocole MetaWear relevé dans le SDK C++ : service `326a9000-…`, commandes sur `326a9001`, notifications sur `326a9006`. Accéléromètre BMI270 (100 Hz, ±8 g) et gyroscope (100 Hz, ±2000 °/s), trames de 16 bits lus en little-endian et convertis en g et °/s. `ble-test.html` sert au diagnostic de connexion.

## Choix de conception

- Zéro dépendance et zéro build : le dépôt se sert tel quel (GitHub Pages)
- Confidentialité : aucune donnée ne quitte le téléphone, pas de compte
- Hors ligne : service worker qui préfère le réseau et retombe sur le cache ; une nouvelle version attend un clic sur « Recharger » (jamais de rechargement au milieu d'une série)
- Export CSV brut des échantillons pour rejouer et régler l'algorithme sur PC

## Tests

- `tests/signal.test.mjs` : mouvements simulés à 100, 60 et 50 Hz, 9 scénarios, erreur maximale de vitesse moyenne 0,04 m/s
- `tests/profile.test.mjs`, `tests/feedback.test.mjs`, `tests/history.test.mjs` : logique pure
- `tests/e2e-*.html` : scénarios dans un navigateur (profils, repos, premier lancement, fonctionnalités)

## Validité et pistes

- Un capteur inertiel du même principe (VmaxPro) est valide pour la vitesse moyenne en squat à 75 % du 1RM (biais 0,01 m/s) mais pas pour le déplacement : d'où l'amplitude masquée
- À faire : validation sur barre réelle avec une distance mesurée, comparaison avec un capteur de référence, test du repli iOS
