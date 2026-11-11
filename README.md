# VBT : vitesse de barre avec un MetaMotion MMS

PWA (Chrome sur Android) qui se connecte en Web Bluetooth à un capteur MetaMotion MMS fixé sur la barre :
vitesse par rep, profil charge-vitesse et 1RM estimé du jour, historique.

- `js/signal.js` : calcul de la vitesse (orientation par gravité + gyroscope, intégration entre deux immobilités)
- `js/profile.js` : régression charge-vitesse et 1RM estimé
- `js/ble.js` : protocole MetaWear en Web Bluetooth
- `ble-test.html` : page de diagnostic de la connexion Bluetooth
- `tests/` : `node tests/signal.test.mjs` et `node tests/profile.test.mjs`
