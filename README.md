# GLSL Hyper-Golfer

**Minifieur de shaders GLSL avec aperçu WebGL en direct — 100 % dans le
navigateur, rien n'est envoyé nulle part.**

Colle un shader façon Shadertoy (une fonction `mainImage`), obtiens une
version minifiée en un clic, et vérifie tout de suite qu'elle rend
exactement pareil grâce au viewport intégré.

## 🎮 Essayer en ligne

👉 **[Ouvrir l'application](https://patrickjaillet.github.io/GLSL-Hyper-Golfer/)**

Aucune installation nécessaire — ça tourne entièrement dans l'onglet du
navigateur.

## ✨ Pourquoi

Sur Shadertoy, dans la demoscene, ou tout contexte où la taille du code
compte (shaders "tweetables" en 280 caractères, par exemple), un shader
lisible avec des noms de variables clairs prend beaucoup plus de place
qu'il n'en a besoin pour fonctionner. L'Hyper-Golfer réduit cette taille
automatiquement :

- **renomme** chaque variable/fonction/paramètre avec le nom le plus
  court disponible,
- **raccourcit** les nombres (`0.5` → `.5`, `2.0` → `2.`),
- **retire** les espaces et retours à la ligne superflus,
- et, si tu actives le mode agressif, va plus loin : accolades
  superflues, déclarations fusionnées, code mort, constantes repliées...

Chaque transformation agressive est *justifiée* : le risque qu'elle
introduit est expliqué, et tu peux activer/désactiver chaque passe
individuellement plutôt que tout ou rien.

## 🖥️ Comment ça marche

L'interface tient sur un seul écran, sans scroll :

- **Source** — colle ton shader ici. La case "Golf agressif" active les 6
  passes optionnelles d'un coup ; le bouton "⚙ Passes" permet de n'en
  garder que certaines.
- **Golfé** — le résultat minifié, avec le taux de réduction et le détail
  de ce qui a été transformé. La case "Version justifiée" ré-affiche le
  code sur plusieurs lignes pour le lire plus facilement (uniquement à
  l'affichage — ce qui est copié et ce qui tourne dans le viewport reste
  toujours la version minifiée).
- **Viewport** — rendu WebGL en temps réel du shader golfé, avec FPS et
  résolution. La case "Comparer" affiche le shader source et le shader
  golfé côte à côte, pour repérer une différence de rendu qui aurait pu
  passer inaperçue.

Sous une fenêtre trop étroite, les 3 panneaux passent automatiquement en
onglets. Les deux séparateurs entre panneaux se redimensionnent à la
souris (ou au clavier, flèches ← →).

## 🔒 Vie privée

Le moteur de minification tourne entièrement côté client (compilé en
WebAssembly) — ton shader ne quitte jamais ton navigateur.

## 🖥️ Utilisation en local

```bash
git clone https://github.com/Patrickjaillet/GLSL-Hyper-Golfer.git
cd GLSL-Hyper-Golfer/web
npm install
npm run dev
```

## 📄 Licence

[MIT](LICENSE) — libre de réutilisation, modification et redistribution.
