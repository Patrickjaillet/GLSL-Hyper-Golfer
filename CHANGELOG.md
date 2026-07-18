# Changelog

Historique des évolutions majeures du moteur et de l'app. Pas de
numéros de version formels (pas de publication sur un registre) — les
entrées sont datées et classées par ordre chronologique inverse.

## 2026-07-18

New entries are in English going forward (Development Conventions,
`ROADMAP.md`).

### Added
- **"About" panel** in the app header (ℹ button next to the language
  toggle): copyright, creator, email, website, repository, and
  license, in French/English like the rest of the UI.
- **README rewritten in English**, with a screenshot of the app
  (`docs/screenshot.png`).
- **`scripts/golf-progress-dashboard.mjs`** (ROADMAP.md Phase 0):
  reports how much smaller the engine golfs the fixture corpus over
  time, with a rigorous `--replay` mode that rebuilds each historical
  engine version and runs it against today's fixtures. See
  `PROGRESS.md`.
- **Standard GitHub repository files**: `CONTRIBUTING.md`,
  `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`.
- **`.github/workflows/release.yml`**: builds the web app and attaches
  a `glsl-hyper-golfer-<tag>.zip` (the built `web/dist`) to the
  matching GitHub release. Runs automatically on every tag push, or
  manually (`workflow_dispatch`, with a tag input) to backfill an
  existing release like `1.0.0`.

### Changed
- LICENSE copyright holder updated to SANDEFJORD DEVELOPMENT.

## 2026-07-13

### Ajouté
- **7e passe agressive : réduction des vecteurs constants**
  (`vec3(1.,1.,1.)` → `vec3(1.)`). Sûr par la spec GLSL elle-même (un
  constructeur de vecteur à un seul argument scalaire diffuse cette
  valeur sur chaque composante) — restreint à `vec2`/`vec3`/`vec4` avec
  des littéraux numériques nus identiques. Synergie avec le repliement
  de constantes : `vec3(2*3,2*3,2*3)` → `vec3(6,6,6)` → `vec3(6)`.
- **Compteur d'octets UTF-8** à côté du compteur de caractères golfés —
  utile pour les concours de taille où les deux peuvent diverger.
- **Raccourci `Ctrl/Cmd+Entrée`** pour lancer le golfing depuis
  n'importe où, y compris le focus dans l'éditeur.
- **Détection GLSL ES 1.00 vs 3.00** : avertit (sans bloquer) quand un
  shader utilise `texture2D`/`textureCube`/`shadow2D`/etc., absentes du
  contexte WebGL2/ES 3.00 dans lequel ce site compile toujours.
- **Éditeur de code CodeMirror 6** en remplacement du `<textarea>` brut
  — coloration syntaxique GLSL ES 3.00/Shadertoy écrite sur mesure,
  auto-complétion par liste de mots, pliage de blocs, recherche/
  remplace, appariement d'accolades. Panneau golfé migré vers le même
  éditeur en lecture seule.
- **i18n français/anglais** avec détection automatique de la langue du
  navigateur, persistée, bascule dans l'en-tête.
- **Accessibilité** : `aria-live` sur les statistiques et le bandeau
  d'erreur, `aria-label` sur les contrôles à icône seule, gestion
  clavier explicite pour les contrôles non natifs.
- **Fuzzing** (`proptest`, `rust-core/tests/fuzz_robustness.rs`) : 3
  propriétés prouvant que le moteur ne panique jamais, sur du texte
  Unicode arbitraire, du "bruit" en forme de GLSL, et des shaders réels
  tronqués aléatoirement.
- **CI de tests** (`.github/workflows/ci.yml`) : `cargo clippy --deny
  warnings`, `cargo test`, `tsc -b` + build web, et la parité Rust↔TS
  sur chaque push/PR — jusqu'ici seul le build de déploiement tournait
  en CI, sans aucun test.
- **Support multi-buffers Shadertoy** (Common + Buffer A-D + Image),
  rendu multi-passe réel (feedback via ping-pong de textures), câblage
  `iChannel0-3` entre buffers, import/export au format JSON Shadertoy
  (clé API fournie par l'utilisateur).
- **Interface "zéro scroll"** : grille 3 colonnes redimensionnables
  (source / golfé / viewport), bascule automatique en mode onglets sous
  un certain seuil de fenêtre, popover pour les passes agressives.

### Corrigé
- **Bug critique en mode sûr** : un renommage de variable pouvait
  casser un sélecteur swizzle sans rapport ailleurs dans le fichier
  (`.x`, `.y`, ... confondus avec une référence de variable du même
  nom). Touchait potentiellement tout shader avec une variable nommée
  d'une seule lettre parmi `x,y,z,w,r,g,b,a,s,t,p,q`.
- **`scripts/parity-test.mjs`/`wasm-check.mjs` cherchaient un binaire
  `golf.exe` en dur**, qui n'existe que sous Windows — invisible tant
  que ces scripts n'avaient tourné que sur un poste Windows ; révélé
  dès le premier run de la CI Linux.
- **Fallback WebGL1** : options de contexte incohérentes entre les
  appels `webgl`/`webgl2`/`experimental-webgl`.

### Nettoyage
- 7 avertissements `cargo clippy` corrigés, une fonction morte
  (`lexer::tokenize`, jamais appelée) supprimée.

## Avant 2026-07-13 (fondations)

- Moteur de golfing tokenizer-based (pas un vrai parseur) : renommage
  scope-aware par fréquence, raccourcissement de nombres, mise en page
  minimale, plus 6 passes agressives (élimination de locaux/écritures
  morts, repliement de constantes entières, affectations composées,
  fusion de déclarations, suppression d'accolades).
- Portage TypeScript du moteur (`golfer.ts`), vérifié octet pour octet
  contre le CLI Rust (`scripts/parity-test.mjs`).
- Compilation en WebAssembly (`wasm-pack`), moteur actif par défaut
  dans le navigateur, repli silencieux sur le port TypeScript si le
  wasm ne charge pas.
- Viewport WebGL2/WebGL1 en direct avec détection d'erreur de
  compilation, mode comparaison source/golfé côte-à-côte.
