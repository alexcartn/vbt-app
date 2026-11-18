# VBT : vitesse de barre avec un capteur MetaMotion ou ton téléphone

PWA gratuite, sans compte et sans serveur, qui mesure la vitesse de la barre à chaque rep en musculation (squat, bench, deadlift), donne un retour en direct pendant la série et estime ton 1RM du jour à partir du profil charge-vitesse.

Démo en ligne : https://alexcartn.github.io/vbt-app/ (ajoute `?demo=1` pour tester avec des données d'exemple)

## Ce que ça fait

- Vitesse moyenne, pic et durée de chaque rep, en direct
- Perte de vitesse dans la série avec alerte d'arrêt réglable (10 / 20 / 30 %), vitesse cible, minuteur de repos, bips
- Profil charge-vitesse et 1RM estimé du jour (indicatif)
- Historique, records par nombre de reps, courbes de progression, profils multiples
- Export CSV brut (accéléromètre et gyroscope) et export JSON de l'historique
- Fonctionne hors ligne (service worker), données uniquement dans le navigateur

## Matériel

- Capteur MetaMotion MMS fixé sur la barre, en Web Bluetooth, ou accéléromètre et gyroscope du téléphone
- Chrome sur Android. Web Bluetooth n'existe pas sur iPhone ; le repli `devicemotion` iOS n'est pas testé

## Limites à connaître

- Pas encore validé sur barre réelle : l'algorithme est validé en simulation (erreur de vitesse moyenne maximale 0,04 m/s sur 9 scénarios). Compare avec un capteur de référence avant de te fier aux valeurs
- L'amplitude en cm est masquée par défaut, car elle n'est pas validée
- Le 1RM estimé sert à doser la charge du jour, pas à choisir une charge à tenter. Le deadlift est le moins fiable

## Lancer en local

```bash
python3 -m http.server 8000   # puis http://localhost:8000
```

Web Bluetooth et les capteurs demandent HTTPS ou localhost.

## Tests

```bash
npm test
```

Les scénarios navigateur sont dans `tests/e2e-*.html` (à ouvrir via un serveur statique).

## Documentation

- [Description technique](docs/technique.md) : architecture, algorithme de vitesse, protocole BLE
- [Notes de développement](docs/notes-dev.md) : détail des fonctionnalités et décisions

## Retours

Issues GitHub : https://github.com/alexcartn/vbt-app/issues/new

## Licence

MIT, voir [LICENSE](LICENSE).
