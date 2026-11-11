# VBT : vitesse de barre avec un MetaMotion MMS

PWA (Chrome sur Android) qui se connecte en Web Bluetooth à un capteur MetaMotion MMS fixé sur la barre :
vitesse par rep, profil charge-vitesse et 1RM estimé du jour, historique.

- `js/signal.js` : calcul de la vitesse (orientation par gravité + gyroscope, intégration entre deux immobilités)
- `js/profile.js` : régression charge-vitesse et 1RM estimé
- `js/ble.js` : protocole MetaWear en Web Bluetooth
- `ble-test.html` : page de diagnostic de la connexion Bluetooth
- `tests/` : `node tests/signal.test.mjs` et `node tests/profile.test.mjs`

## Retour pendant la série

- `js/feedback.js` : perte de vitesse (dernière rep contre la meilleure), seuil d'arrêt (Off / 10 / 20 / 30 %), export CSV brut
- `js/audio.js` : bips (Web Audio) ; l'alerte d'arrêt est trois bips graves
- Une rep peut être marquée ratée (non comptée dans la perte de vitesse ni le profil) ou supprimée ; la correction est répercutée sur la série enregistrée
- Export brut de la dernière série en CSV (`i,ax,ay,az,gx,gy,gz`, 1,5 s avant le début incluses) pour rejouer et régler l'algorithme sur PC ; export JSON de l'historique
- Tests : `node tests/feedback.test.mjs` ; scénario complet dans un navigateur : `tests/e2e-feedback.html` (via un serveur statique)

## Profils et historique

- Profils : « Alexandre » par défaut, création depuis le sélecteur en haut des écrans, une série est enregistrée au nom du profil actif ; la vitesse minimale (1RM) est propre à chaque profil
- Historique (`js/history.js`) : par exercice et par profil, courbe de progression (1RM estimé du jour, ou meilleure vitesse à une charge choisie), séances du jour avec volume, détail d'une série (reps, barres, courbe de rep, correction), déplacement d'une série vers un autre profil
- Un profil ne se supprime que s'il n'a plus de série ; l'onglet « 1RM » (ex-« Profil ») montre le profil charge-vitesse du jour
- Tests : `node tests/history.test.mjs` ; scénario navigateur : `tests/e2e-profiles.html`
