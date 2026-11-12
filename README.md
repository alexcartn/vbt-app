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

- Profils : aucun par défaut, le premier est demandé au premier lancement (écran d'accueil qui explique que les données restent sur le téléphone, sans compte) ; les anciennes données sans profil sont rattachées à un profil « Alexandre » ; création depuis le sélecteur en haut des écrans, une série est enregistrée au nom du profil actif ; la vitesse minimale (1RM) est propre à chaque profil
- Historique (`js/history.js`) : par exercice et par profil, courbe de progression (1RM estimé du jour, ou meilleure vitesse à une charge choisie), séances du jour avec volume, détail d'une série (reps, barres, courbe de rep, correction), déplacement d'une série vers un autre profil
- Un profil ne se supprime que s'il n'a plus de série ; l'onglet « 1RM » (ex-« Profil ») montre le profil charge-vitesse du jour
- Tests : `node tests/history.test.mjs` ; scénario navigateur : `tests/e2e-profiles.html`

## Minuteur de repos

- Réglage « Repos » (Off par défaut, 2 / 3 / 5 min) avant la série ; le compte à rebours démarre quand une série est enregistrée
- À zéro : deux bips aigus et une vibration (une seule fois), puis le dépassement s'affiche (+0:12) sur fond plein
- Il disparaît au démarrage de la série suivante, ou avec « Passer »
- Tests : `restDisplay` dans `tests/feedback.test.mjs`, scénario navigateur `tests/e2e-rest.html`

## Prudence et validité (littérature, nov. 2026)

Vérifié dans des résumés et extraits d'articles, un seul lu en détail :
- Un capteur inertiel du même principe (VmaxPro) est valide pour la vitesse moyenne en squat à 75 % du 1RM (biais 0,01 m/s, limites d'accord 0,10 m/s) mais pas pour le déplacement (environ 10 cm d'écart) : **notre amplitude en cm est masquée** sauf avec le réglage « Test de mesure ». Notre algorithme n'est validé qu'en simulation : le test de distance mesurée reste à faire.
- Le 1RM estimé est **indicatif** (dosage de la charge du jour, pas un poids à tenter). Le deadlift est le moins fiable ; la vitesse minimale par défaut (squat 0,30 général, bench 0,17, deadlift 0,15 non confirmé) est signalée tant qu'elle n'est pas individualisée.
- « Définir comme vitesse minimale » (détail d'une rep) enregistre la vitesse de ta rep réussie la plus lente à l'échec : une valeur individuelle prédit mieux qu'une valeur générale.
- Seuils de perte de vitesse 10 / 20 / 30 % : 10 à 20 % suffisent pour la force ; les zones de couleur restent une heuristique de l'app.

## Vitesse cible, records, séries sans capteur

- Vitesse cible (Off ou 0,10 à 2,00 m/s par pas de 0,05) : ligne pointillée sur les barres, écart de chaque rep, cible gardée avec la série
- Records par nombre de reps (1RM à 5RM, reps valides, séries sans capteur comprises) dans l'Historique
- « Série sans capteur » : charge et nombre de reps saisis à la main ; comptée dans le volume et les records, pas dans le profil charge-vitesse
- Tests : `repMaxes`, `repCount`, `targetDelta`, `mvtNote` ; scénario navigateur `tests/e2e-features.html`

## Téléphone comme capteur

- Bouton « Utiliser le téléphone » : accéléromètre et gyroscope du téléphone (`js/phone.js`, Generic Sensor API sur Chrome Android, repli `devicemotion`), mêmes calculs que le MetaMotion
- Fréquence mesurée sur un Android : 60 Hz (plafond de Chrome). Les durées en échantillons du calcul (immobilité, calibrage) sont ramenées à la même durée en secondes (`Tracker.setDt`) ; tests simulés à 60 et 50 Hz dans `tests/signal.test.mjs`
- `phone-test.html` (et `dist/phone-test-standalone.html`) : mesure de la fréquence et de la gigue des capteurs
- Le repli iOS (`devicemotion`) n'est pas testé sur un vrai appareil
- Le téléphone sur la barre n'est plus visible : compte sur les bips (réglage « Son »)
- Pas de validation sur barre réelle : comparer avec le MetaMotion sur les mêmes séries avant de se fier aux valeurs

## Mise à jour et premier lancement

- Une nouvelle version (service worker) attend que l'utilisateur touche « Recharger » dans le bandeau ; le contrôle se fait à chaque retour sur l'app ; une série en cours demande une confirmation
- Pensez à changer le nom du cache dans `sw.js` (`vbt-vN`) à chaque version publiée, sinon aucun bandeau n'apparaît
- Tests navigateur : `tests/e2e-welcome.html` (premier profil)
