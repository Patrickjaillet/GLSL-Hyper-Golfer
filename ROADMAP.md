# 🏌️ ROADMAP — GLSL Hyper-Golfer → référence mondiale du shader golfing

État des lieux initial (basé sur lecture complète du repo au
2026-07-13) — voir plus bas la mise à jour du même jour après la
première "killer feature" :

- **Moteur** (`rust-core/`) : tokenizer maison + renommage scope-aware +
  raccourcissement de nombres + 6 passes agressives (dead locals, dead
  stores, constant folding entier, compound assign, merge de
  déclarations, suppression d'accolades). Compilé en WASM, avec repli
  TypeScript (`web/src/golfer.ts`) si le WASM ne charge pas. Bonne
  couverture de tests unitaires côté Rust.
- **Web** (`web/`) : Vite + TS vanilla, 3 panneaux (source / golfé /
  viewport), comparaison side-by-side, popover de passes, export GitHub
  Pages. Un seul fichier shader façon `mainImage`, uniforms
  `iResolution/iTime/iTimeDelta/iFrame/iMouse` uniquement — **pas de
  iChannel réellement câblés**, pas de multi-passes, pas de textures.
- **Pas de** : tests e2e, pas de CI de tests (le workflow ne fait que
  `npm run build`, aucun `cargo test` ni `npm test`), pas
  d'internationalisation (tout est en français en dur).

✅ **Mise à jour (13/07/2026, même jour)** — la première "killer
feature" de la section 9 est faite : support multi-buffers (Common +
Buffer A-D + Image), câblage iChannel buffer-à-buffer, import/export
Shadertoy. Voir le détail complet en section 2. Les points "pas de
iChannel câblés / pas de multi-passes" ci-dessus ne sont donc plus
vrais pour le cas buffer-à-buffer — restent vrais pour tout ce qui est
texture/vidéo/audio/webcam/cubemap. Les deux autres killer features
(section 9, items 2 et 3) et le reste du document (sections 1, 3-8)
restent à faire.

Cette roadmap couvre ce qu'il faudrait pour en faire **le** site de
référence pour le golfing de shaders GLSL/Shadertoy — au niveau moteur,
compatibilité Shadertoy, UX et infra. Hors périmètre volontairement :
fonctionnalités communautaires/sociales (comptes, partage public,
classements), thèmes visuels, et optimisation mobile.

---

## 1. Moteur de golfing (rust-core)

### 1.1 Nouvelles passes agressives
- [ ] Renommage des **swizzles répétés** en variable temporaire si ça
      réduit la taille (`p.xyz` réutilisé → facultatif, à mesurer)
- [ ] **Inlining de fonctions** appelées une seule fois (une fonction
      utilisée à un seul call-site peut être collée en ligne)
- [ ] **Extraction de sous-expressions communes** (CSE) quand ça réduit
      la taille nette (attention : golfing veut souvent l'inverse —
      dupliquer est parfois plus court que déclarer une variable)
- [ ] Fusion d'opérateurs : `x=x+1.` → `++x`/`x++` quand plus court
- [ ] Réécriture `a?b:c` à partir de `if/else` quand plus court
- [ ] Détection et fusion de `for`/`while` équivalents plus courts
- [ ] Suppression de `return;` final implicite en fin de fonction `void`
- [ ] Réduction des vecteurs constants (`vec3(1.,1.,1.)` → `vec3(1.)`)
- [ ] Réutilisation d'un paramètre de fonction comme variable de travail
      (évite une déclaration locale)
- [ ] Constant folding étendu aux flottants (pas seulement les entiers
      `*`, `/`, `%` actuels) avec garde stricte sur la précision
- [ ] Détection de code mort **inter-instructions non adjacentes**
      (actuellement limité aux paires strictement adjacentes, documenté
      comme limite connue dans les tests)
- [ ] Passe de **canonicalisation des espaces autour des opérateurs**
      unaires ambigus (`- -1.` vs `--1.`) avec tests de non-régression
- [ ] Rapport "diff sémantique" formel : preuve que chaque passe
      préserve l'AST-équivalence (pas juste des tests golden)

### 1.2 Robustesse / sûreté
- ✅ **FAIT (13/07/2026) — Fuzzing via `proptest`** (`rust-core/tests/fuzz_robustness.rs`,
      3 propriétés, ~768 entrées aléatoires par run). `cargo-fuzz`
      (libFuzzer) écarté au profit de `proptest` : fonctionne sur stable
      (pas de nightly requis), s'intègre comme un `#[test]` normal donc
      tourne dans le `cargo test` déjà câblé en CI (voir section 5) sans
      job séparé, et fait du shrinking automatique vers un cas minimal
      en cas d'échec. Trois propriétés, volontairement **pas** "golfé ==
      source après évaluation" (prouver l'équivalence sémantique
      demanderait un vrai évaluateur GLSL, hors de portée) mais "ne
      panique jamais", plus faible mais honnête et automatisable :
      (1) Unicode arbitraire (`.{0,400}` — teste la robustesse aux
      limites de caractères multi-octets, la classe de bug la plus
      probable dans un tokenizer qui tranche des `&str` par offset
      d'octet), (2) "bruit" en forme de GLSL (identifiants/nombres/
      ponctuation/accolades/préprocesseur, plus susceptible de titiller
      les heuristiques de déclaration/accolades/nombres que de
      l'Unicode uniformément aléatoire), (3) troncature aléatoire de
      shaders réels (`fixtures/fractal.glsl`, `dead_stores.glsl`,
      `define_safety.glsl`) — le cas de "cassure" le plus probable en
      usage réel (collage tronqué), pas du bruit pur. Les 3 passent sur
      ~768 entrées sans aucun panic trouvé.
- [ ] Suite de **shaders réels golden** — **hors de ma portée** :
      nécessiterait de récupérer des shaders Shadertoy avec licence
      vérifiée, une décision légale/éditoriale qui n'est pas la mienne à
      prendre. Reste faisable manuellement par l'utilisateur (choisir
      quelques shaders CC0/CC-BY connus et les ajouter à `fixtures/`).
- [ ] Score de confiance par passe (marquer certaines passes
      "expérimentales" vs "sûres" dans l'UI, avec avertissement)
- [ ] Détecter et refuser proprement les shaders GLSL ES 1.00 vs 3.00
      incompatibles (ex : `texture2D` vs `texture`) plutôt que produire
      un résultat qui ne compile qu'à moitié
- [ ] Gestion propre des **erreurs de parsing** (aujourd'hui tout
      repose sur des heuristiques token-based ; ajouter un vrai mode
      "je ne comprends pas cette construction, je la laisse intacte"
      avec warning visible, plutôt que de risquer un golf incorrect)

### 1.3 Config / API du moteur
- [ ] Exposer un **niveau de golf réglable** (safe / balanced /
      aggressive / max-risk) plutôt que la simple checkbox actuelle
- [ ] API `golf_with_options` acceptant une **whitelist de noms à ne
      jamais renommer** (utile pour les shaders qui exposent des
      uniforms custom)
- ✅ **FAIT (13/07/2026) — Support de plusieurs buffers en une seule
      passe** (voir section 2) — mais **pas** de "renommage cohérent
      inter-fichiers" comme prévu ici à l'origine : il s'est avéré que
      ce n'est pas nécessaire (chaque buffer compile comme un programme
      GLSL séparé), donc `golf_with_options` golfe chaque buffer
      indépendamment sans aucun changement d'API. Voir la note détaillée
      en section 2.
- [ ] CLI (`src/bin/golf.rs`) : ajouter flags pour toutes les options,
      mode `--watch`, mode `--diff-only`

---

## 2. Compatibilité Shadertoy (le vrai différenciateur)

Le point le plus important pour devenir *le* site de golfing GLSL :
aujourd'hui l'outil ne golfe qu'un `mainImage` isolé. Un vrai golfeur
Shadertoy a besoin de :

- ✅ **FAIT (13/07/2026) — Support multi-buffers (Buffer A/B/C/D + Image
      + Common), câblage iChannel buffer-à-buffer, import/export.**
      Implémenté d'un bloc (`web/src/renderer.ts::MultiPassRunner`,
      `web/src/main.ts`) :
  - **Modèle de projet** : Common (texte partagé, fusionné dans chaque
    autre passe avant golfing — pas de sortie indépendante, l'onglet
    "Common" dans le panneau Golfé l'explique plutôt que d'afficher un
    résultat trompeur) + jusqu'à 4 buffers + Image, onglets dans le
    panneau Source (`+ Buffer` / `✕` pour ajouter/retirer).
  - **Rendu multi-passe réel** (`MultiPassRunner`, WebGL2 requis) :
    chaque buffer actif a une paire de textures ping-pong ; l'ordre de
    rendu A→B→C→D→Image swap le front/back de chaque buffer *juste
    après* l'avoir rendu, donc un buffer qui en référence un autre déjà
    rendu ce frame voit sa sortie fraîche (comme le vrai Shadertoy),
    tandis qu'une auto-référence (feedback) ou une référence "en avance"
    (A lisant D) lit nécessairement la sortie de la frame précédente —
    règle unique qui évite tout risque de lire une texture pendant
    qu'elle est encore la cible de rendu (hasard WebGL classique des
    boucles de feedback).
  - **Câblage iChannel** limité aux sorties de buffer pour l'instant
    (sélecteur "aucune" / "Buffer A".."Buffer D") — textures statiques,
    vidéo, audio, webcam, cubemaps, volume textures et clavier restent
    **non supportés**, sélecteur non proposé pour ces types. C'est la
    limite assumée la plus importante de cette implémentation : voir
    plus bas dans cette section pour ce qui manque encore.
  - **Golfing par buffer sans aucun changement `rust-core`** : chaque
    passe (Common + code propre) est golfée indépendamment via le
    pipeline existant — une découverte utile en concevant cette
    fonctionnalité, c'est que la cohérence de renommage inter-buffers
    (item du roadmap original) n'est en fait **pas nécessaire** : chaque
    buffer Shadertoy compile comme un programme GLSL séparé, donc rien
    n'exige que "Common" soit renommé pareil dans deux buffers
    différents pour que ce soit correct — seule la taille totale
    pourrait théoriquement varier légèrement selon l'ordre de
    renommage, pas la correction.
  - **Import depuis une URL/ID Shadertoy** — utilise l'API publique
    Shadertoy (`/api/v1/shaders/{id}`), avec la clé API **fournie par
    l'utilisateur** (gratuite sur shadertoy.com/myapps, demandée une
    fois et gardée en `localStorage`) puisque cette app n'a et ne peut
    pas avoir de clé à elle. Reconstruit Common/buffers/Image et le
    câblage iChannel de type "buffer" ; tout type de canal non supporté
    (texture/vidéo/audio/webcam/cubemap) est explicitement signalé à
    l'utilisateur après import plutôt que silencieusement ignoré. *Non
    vérifié contre un vrai fetch cette session* (pas d'accès réseau ni
    de clé API dans le bac à sable) — implémenté contre la forme
    documentée et stable de l'API, mais deux risques réels non
    éliminés : (1) l'API Shadertoy pourrait ne pas envoyer d'en-têtes
    CORS permissifs pour un fetch navigateur depuis une origine tierce
    comme ce site, auquel cas l'import échoue avec une erreur
    réseau/CORS qu'aucun code côté client ne peut contourner ; (2) le
    format exact de `inputs[]`/`outputs[]` n'a pas pu être confirmé sur
    un shader réel. **À tester en conditions réelles par l'utilisateur.**
  - **Export vers JSON Shadertoy** — reconstruit `renderpass[]` à partir
    du projet courant (best-effort, mêmes limites que l'import : seuls
    les canaux de type buffer sont exportés).
  - Vérifié en headless (Playwright, clics via `element.click()` en
    `page.evaluate` pour contourner un blocage du bac à sable déjà
    documenté en session précédente — voir ROADMAP-UI.md) : projet par
    défaut sans erreur, ajout de buffer, câblage `iChannel0` de Image
    vers Buffer A, golfing des deux passes sans erreur de compilation,
    stats par passe correctes, onglet Common affiche bien le message
    explicatif plutôt qu'un faux résultat, suppression de buffer
    nettoie le câblage orphelin ailleurs, export ne lève pas d'erreur.
    **Non vérifié en navigateur réel** (rendu visuel du feedback
    multi-buffer, import Shadertoy live) — à confirmer par
    l'utilisateur.
  - **Régression assumée** : `MultiPassRunner` exige WebGL2. Un
    fallback existe (`ShaderRunner`, l'ancien moteur mono-passe
    WebGL1/2, conservé dans `renderer.ts`) qui golfe/rend le seul pass
    Image si WebGL2 est indisponible — tout buffer configuré est alors
    ignoré avec un avertissement explicite dans le bandeau d'erreur,
    plutôt que silencieusement.
- [ ] Support **cubemaps** et **volume textures** en entrée
- [ ] Support des **textures statiques** (upload d'image / textures
      stock Shadertoy) comme source de canal
- [ ] Uniforms manquants : `iChannelTime[4]`, `iChannelResolution[4]`,
      `iDate`, `iSampleRate`, `iFrameRate`
- [ ] Support **audio input** (`iChannel` en mode microphone/FFT comme
      Shadertoy)
- [ ] Support **vidéo** et **webcam** comme source de canal
- [ ] Support clavier (`iKeyboard` via texture spéciale, comme sur
      Shadertoy)

---

## 3. Éditeur & expérience de code

- ✅ **FAIT (13/07/2026) — Remplacé le `<textarea>` brut par CodeMirror 6**
      (`web/src/editor.ts`, `web/src/glslLanguage.ts`) :
  - **CodeMirror 6 plutôt que Monaco** : bundle bien plus léger et
    modulaire (Monaco embarque son propre worker TypeScript/JSON/CSS
    inutile ici et pèse significativement plus lourd), s'intègre
    proprement avec Vite sans configuration spéciale (Monaco demande
    souvent un plugin Vite dédié pour ses web workers).
  - [x] **Coloration syntaxique GLSL** — pas de grammaire Lezer complète
        (aurait été un projet à part entière), un `StreamParser`
        générique C-like (`@codemirror/legacy-modes`) configuré avec un
        vocabulaire GLSL ES 3.00/Shadertoy écrit à la main (mots-clés,
        types, fonctions builtin, `iResolution`/`iTime`/`mainImage`/...).
        Il existe un mode `shader` intégré dans ce même paquet, mais il
        est resté figé sur GLSL ES 1.00 (`texture2D`, pas de `uint`/
        `switch`/`layout`) et ne connaît pas le vocabulaire Shadertoy —
        écrit le nôtre plutôt que de composer avec ces lacunes.
        **Dupliqué depuis `rust-core/src/vocab.rs`** (TS qui tourne dans
        le navigateur ne peut pas interroger le vocabulaire Rust/wasm à
        l'exécution) — peut dériver sans casser quoi que ce soit
        fonctionnellement, ça ne change que la coloration, jamais ce qui
        est renommé/protégé par le vrai moteur.
  - [x] **Auto-complétion** basique par liste de mots (mots-clés/types/
        builtins/uniforms Shadertoy) via `@codemirror/autocomplete` —
        pas d'auto-complétion contextuelle consciente des types/scopes
        (demanderait la vraie grammaire écartée ci-dessus).
  - [x] **Pliage de blocs, multi-curseur, recherche/remplace,
        appariement d'accolades** — tous fournis nativement par
        CodeMirror 6 (`@codemirror/language`/`@codemirror/search`), pas
        de travail spécifique à ce projet au-delà du câblage.
  - [ ] **Lint en direct** (erreurs de syntaxe soulignées avant même de
        golfer) — **pas fait** : nécessiterait un vrai parseur GLSL (le
        moteur de golf lui-même est volontairement token-heuristique,
        pas un parseur complet, donc ne peut pas servir de base à un
        lint fiable sans un projet séparé).
  - Thème CodeMirror entièrement personnalisé pour matcher la palette
    existante (`--ink`/`--paper`/`--cyan`/`--amber`, pas un thème
    générique importé) — garde l'identité visuelle "banc d'essai" de la
    section Design plus bas.
  - Panneau Golfé migré vers une instance CodeMirror **en lecture
    seule** aussi, par cohérence (coloration syntaxique du résultat
    golfé, pas seulement du source).
  - **Coût réel, assumé** : la taille du bundle JS gzippé est passée
    d'environ 55 Ko à ~146 Ko. Impact direct sur l'item "audit de
    bundle size" (section 5) et sur la future PWA offline (section 8) —
    toujours largement acceptable pour une app qui tourne 100%
    client-side, mais notable.
  - Vérifié en headless (frappe clavier réelle simulée à travers le
    vrai pipeline d'entrée CodeMirror, pas juste une valeur posée dans
    le DOM) : montage CodeMirror confirmé dans les deux panneaux,
    saisie + golfing fonctionnels, bascule de langue fonctionnelle,
    placeholder de l'onglet Common toujours correct — zéro erreur
    console. **Non vérifié visuellement en navigateur réel** (rendu
    des couleurs de coloration syntaxique, ergonomie du pliage de
    blocs/multi-curseur) — à confirmer par l'utilisateur.
- ✅ **FAIT (13/07/2026) — i18n français/anglais** (`web/src/i18n.ts`)
      — non prévu comme item séparé dans le document d'origine mais
      explicitement listé comme faisant partie de la killer feature 3
      en section 9 ("condition d'entrée pour toucher la communauté
      Shadertoy internationale"). Détection automatique de la langue du
      navigateur au premier chargement, persistée en `localStorage`,
      bouton de bascule FR/EN dans l'en-tête. Couverture : tous les
      libellés/tooltips/placeholders statiques du template (via
      attributs `data-i18n`/`data-i18n-title` réappliqués au changement
      de langue) plus tous les messages générés dynamiquement (bandeau
      d'erreur, prompts/alertes d'import Shadertoy, stats par passe).
      Les libellés Common/Buffer A-D/Image restent volontairement en
      anglais dans les deux langues — ce sont les noms propres utilisés
      par Shadertoy lui-même, les traduire aurait cassé la
      correspondance avec le vocabulaire que les utilisateurs
      connaissent déjà.
- [ ] **Diff visuel** ligne à ligne / token à token entre source et
      golfé (surlignage de ce qui a changé, pas juste avant/après)
- [ ] Mode **historique/undo** dédié au golfing (annuler juste la
      dernière passe)
- [ ] Sauvegarde automatique locale (IndexedDB) du travail en cours,
      avec plusieurs "brouillons" nommés
- [ ] Raccourcis clavier complets (golfer = `Cmd/Ctrl+Enter`, etc.),
      palette de commandes façon VS Code (`Cmd+K`)
- [ ] Affichage de la **taille en octets réels** vs caractères
      (important pour les concours "N caractères" en UTF‑8 vs ASCII)
- [ ] Compteur spécifique pour les formats de concours connus (tweet
      280, démo 4k/8k/64k, JS1k-style, etc.) avec badge "tient dans X"

---

## 4. Viewport & rendu

- [ ] Passer le fallback WebGL1 en **WebGPU** en option (meilleure
      fidélité avec les derniers builtins GLSL/`#version 300 es`)
- [ ] Export **capture d'écran** et **enregistrement vidéo/GIF** du
      rendu golfé
- [ ] Réglages de résolution custom et pixel ratio pour tester le rendu
      "tel qu'affiché sur Shadertoy" (qui downscale parfois)
- [ ] Overlay d'erreurs GLSL avec **ligne exacte** surlignée dans
      l'éditeur (aujourd'hui le message de log brut du driver seulement)
- [ ] Mode **VR/360** preview pour les shaders qui le supportent
- [ ] Profilage GPU basique (temps par frame, pas juste FPS global)

---

## 5. Qualité, tests & CI

- ✅ **FAIT (13/07/2026) — Le workflow CI ne faisait *aucun* test, même
      pas `cargo test`.** Ajouté `.github/workflows/ci.yml` (séparé de
      `deploy-pages.yml`, qui reste uniquement responsable du build/
      déploiement) avec 3 jobs sur chaque push/PR : `cargo test
      --all-targets` (unitaires + les 3 propriétés fuzz de la section
      1.2), `tsc -b` + `npm run build` côté web, et
      `scripts/parity-test.mjs` (Rust CLI ↔ port TS).

      **Bug réel trouvé dès le premier run** : le job `parity` a échoué
      — `scripts/parity-test.mjs` et `scripts/wasm-check.mjs`
      cherchaient tous les deux un binaire nommé en dur `golf.exe`, qui
      n'existe que sous Windows (`cargo build` ne produit que `golf` sur
      Linux/macOS). Ce bug existait déjà avant cette session mais
      n'avait jamais été détecté puisque ces deux scripts n'avaient
      jusqu'ici tourné que sur ce bac à sable Windows — la CI Linux l'a
      révélé au premier run réel. Corrigé (choix de l'extension via
      `process.platform`), reconfirmé vert sur GitHub Actions ensuite
      (les 3 jobs, y compris `parity`). Un exemple concret de pourquoi
      "ça marche en local" n'est pas une preuve suffisante — même leçon
      que le bug swizzle-après-point plus haut, cette fois côté outillage
      plutôt que moteur.
  - [ ] tests e2e (Playwright) du parcours golf → viewport → copier
  - [ ] tests de non-régression visuelle (screenshot diff du viewport)
  - [ ] lint TS strict (`eslint`) — `tsc -b` est déjà en CI (ci-dessus)
        mais pas de linter dédié
  - [ ] `cargo clippy --deny warnings` en CI
  - [ ] audit de bundle size (le WASM + JS doivent rester légers) —
        d'autant plus pertinent maintenant : CodeMirror (section 3) a
        fait passer le JS gzippé d'environ 55 Ko à ~146 Ko
  - [ ] `node scripts/wasm-check.mjs` en CI — délibérément pas ajouté
        cette fois : nécessiterait d'installer la cible
        `wasm32-unknown-unknown` + `wasm-pack` dans le job, un coût de
        temps de CI non négligeable pour un troisième niveau de parité
        déjà couvert indirectement par `cargo test` (même code source)
- [ ] Coverage rapport publié (codecov ou équivalent)
- [ ] Benchmarks de perf du moteur (`criterion`) suivis dans le temps
      pour détecter les régressions sur gros shaders

---

## 6. Accessibilité & internationalisation

- [ ] Passer l'UI (actuellement 100% français en dur dans `main.ts`)
      en **i18n** (fr/en au minimum — la communauté Shadertoy est très
      majoritairement anglophone)
- [ ] Audit accessibilité complet (contrastes, navigation clavier,
      lecteurs d'écran, `aria-live` sur les stats qui changent)

---

## 7. Documentation & pédagogie

- [ ] Changelog public par version du moteur, avec exemples de shaders
      que chaque nouvelle passe sait golfer en plus
- [ ] Playground de comparaison "notre golf vs golf manuel d'expert"
      pour construire la confiance dans l'outil

---

## 8. Infra & distribution

- [ ] Domaine dédié + PWA installable (fonctionne offline, le moteur
      est déjà 100% client-side donc c'est presque gratuit à ajouter)
- [ ] SEO réel (meta tags, sitemap, pages statiques par shader partagé
      pour indexation) — actuellement une SPA pure, invisible pour les
      moteurs de recherche
- [ ] API publique du moteur (endpoint ou package npm/crates.io du
      moteur seul) pour que d'autres outils/CI golfent des shaders
      automatiquement
- [ ] Package **CLI installable** (`cargo install`/`npx`) documenté
      séparément du site web, pour intégration dans des pipelines de
      démoscene (4k/8k intros)
- [ ] Extension **VS Code** utilisant le même moteur wasm pour golfer
      sans quitter l'éditeur

---

## 9. Différenciateurs "killer feature" (priorité stratégique)

Si une seule chose devait être choisie pour dominer le game des sites
de golf GLSL, dans l'ordre d'impact probable :

- ✅ **FAIT (13/07/2026) — 1. Support Shadertoy multi-buffers + import
      URL** (section 2) — buffer-à-buffer complet ; texture/vidéo/
      audio/webcam/cubemap encore non supportés (voir section 2 pour le
      détail exact de ce qui reste). Import/export non vérifiés contre
      l'API Shadertoy réelle (pas de réseau/clé API disponible en
      session), reste à tester par l'utilisateur.
- 🟡 **PARTIEL (13/07/2026) — 2. Preuve de correction automatisée**
      (sections 1.2 et 5) — fuzzing `proptest` fait (3 propriétés, "ne
      panique jamais" sur ~768 entrées adversariales/quasi-GLSL/shaders
      tronqués) **et** câblé en CI sur chaque push/PR (`ci.yml`), donc
      la preuve tourne en continu plutôt qu'une seule fois. Reste non
      fait : le "diff visuel" ligne à ligne/token à token entre source
      et golfé (en réalité section 3, pas 4 — la roadmap d'origine
      référençait la mauvaise section ici) et le "rapport diff
      sémantique formel" de la section 1.1. La preuve actuelle couvre
      "ne crashe jamais", pas "produit un résultat sémantiquement
      équivalent" — cette dernière demanderait un vrai évaluateur GLSL,
      un projet à part entière.
- ✅ **FAIT (13/07/2026) — 3. Éditeur pro (CodeMirror 6) + i18n
      anglais** (section 3) — les 3 killer features de cette section
      sont maintenant toutes faites. Reste explicitement non fait dans
      celle-ci : le lint en direct (demanderait un vrai parseur GLSL) et
      l'audit du coût en taille de bundle qu'elle introduit (~146 Ko
      gzippé désormais, voir section 5).

**Les 3 killer features de cette section sont faites.** Reste tout le
reste du document (sections 1, 3 hors éditeur, 4, 6, 7, 8) — la
suite logique la plus proche des 3 items ci-dessus serait sans doute le
"diff visuel" (section 3) et le lint en direct, puisqu'ils prolongent
directement ce qui vient d'être construit.
