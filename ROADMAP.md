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
- ✅ **FAIT (14/07/2026) — Fusion d'opérateurs : `a+=1;`/`a-=1;` →
      `++a;`/`--a;`**, 9e passe agressive
      (`aggressive.rs::increment_decrement`, miroir TS dans
      `golfer.ts`). Tourne juste après `compound_assignments` dans le
      pipeline, donc `a=a+1;` (déjà replié en `a+=1;` par cette
      dernière) en bénéficie aussi — testé explicitement que les deux
      passes composent (`compound_assignment_single_term_rhs`).
      **Forme préfixe (`++a`), jamais postfixe, choix délibéré et pas
      juste stylistique** : une affectation composée est une expression
      en GLSL (comme en C) qui peut être elle-même lue (`foo(a+=1)`
      est du GLSL valide) — `a+=1` s'évalue à la *nouvelle* valeur de
      `a`, exactement ce que fait `++a` par définition, alors que `a++`
      s'évaluerait à l'ancienne valeur et changerait silencieusement
      le résultat. Les deux formes font la même taille, donc le choix
      n'était pas motivé par le gain d'octets mais par la correction —
      testé explicitement (`increment_decrement_uses_prefix_so_expression_value_stays_correct`).
      Ne se déclenche que quand le montant est *exactement* `1`/`1.`
      (comparaison sur le texte déjà raccourci, pas le texte brut —
      `1.0` devient `1.` avant même que cette passe tourne) ; `1u` /
      `1.0f` / `1e0` sont hors du scope volontairement étroit (se
      raccourcissent respectivement en `1u`/`1.f`/inchangé-avec-exposant,
      jamais en `1`/`1.` exactement). 4 tests Rust dédiés + nouvelle
      fixture `fixtures/increment_decrement.glsl` (couvre aussi le cas
      d'usage réel le plus courant, l'en-tête d'un `for` : `i=i+1`
      dans la clause d'incrément devient `++i`) en parité Rust/TS/wasm
      (34/34) + checkbox dédiée dans l'UI, vérifiée en headless. Trouvé
      en passant : la fixture préexistante `struct_safety.glsl`
      contenait déjà un `+=1`/`-=1` sans le savoir — 2 octets gagnés
      dessus gratuitement, confirmés identiques Rust/TS/wasm.
- [ ] Renommage des **swizzles répétés** en variable temporaire si ça
      réduit la taille (`p.xyz` réutilisé → facultatif, à mesurer)
- [ ] **Inlining de fonctions** appelées une seule fois (une fonction
      utilisée à un seul call-site peut être collée en ligne)
- [ ] **Extraction de sous-expressions communes** (CSE) quand ça réduit
      la taille nette (attention : golfing veut souvent l'inverse —
      dupliquer est parfois plus court que déclarer une variable)
- ✅ **FAIT (14/07/2026) — Réécriture `a?b:c` à partir de `if/else`**,
      10e passe agressive (`aggressive.rs::ternary_from_if_else`,
      miroir TS). Reconnaît `if(COND){A=X;}else{A=Y;}` (accolades
      optionnelles de chaque côté, indifféremment) et le remplace par
      `A=(COND)?X:Y;` — toujours strictement plus court par
      construction (le `if()`/`else`/la répétition de `A=` disparaissent
      contre juste `?`/`:`), donc aucune mesure de taille n'est
      nécessaire, seulement une vérification de correction.
      **Pas de risque de dangling-else** : contrairement à
      `strip_redundant_braces`, cette passe consomme un `if...else`
      déjà complet comme une seule unité — le `else` appartient
      forcément à *ce* `if`, jamais à un `if` englobant, donc rien à
      protéger de ce côté-là, même en cas d'imbrication
      (`if(a)if(b)x=1.;else x=2.;` reste correct après coup).
      **Deux restrictions volontairement étroites** pour rester sûr
      par construction plutôt qu'heuristique :
  - `X`/`Y` (les valeurs affectées) sont chacun restreints à un
    unique terme `scan_primary` — même restriction que le membre
    droit de `compound_assignments`, pour la même raison (un terme
    plus long risquerait de se ré-associer différemment une fois
    déplacé à côté de `?`/`:`).
  - `COND` n'est en revanche **jamais réinterprété** : la passe repère
    seulement où il commence et finit (via le même traqueur de
    parenthèses `skip_balanced` qu'ailleurs), puis le colle **entouré
    de parenthèses fraîches** `(COND)` plutôt que tel quel. Ça évite
    toute question de précédence — en particulier le piège où `COND`
    contiendrait lui-même un `?:` de haut niveau : collé sans
    parenthèses, `?:` étant associatif à droite, `a?b:c?x:y` se
    relirait comme `a?b:(c?x:y)`, pas le `(a?b:c)?x:y` voulu. Coût :
    2 caractères, toujours rentable face à l'alternative `if/else`.
    Testé explicitement (`ternary_wraps_condition_containing_its_own_ternary`).
      6 tests Rust dédiés (accolades/sans accolades, cibles différentes
      refusées, membre droit multi-terme refusé, condition contenant
      son propre ternaire, `==` jamais confondu avec une affectation)
      + nouvelle fixture `fixtures/ternary_from_if_else.glsl` (couvre
      accolades et sans-accolades) en parité Rust/TS/wasm (36/36) +
      checkbox dédiée, vérifiée en headless. **Non fait** : ne gère pas
      le cas où les deux branches déclarent une variable localement
      différente qui converge (seulement l'affectation à une variable
      déjà existante des deux côtés) — hors du scope volontairement
      étroit de cette première version.
- [ ] Détection et fusion de `for`/`while` équivalents plus courts
- ✅ **FAIT (14/07/2026) — Suppression de `return;` final en fin de
      fonction `void`**, 8e passe agressive
      (`aggressive.rs::strip_trailing_void_return`, miroir TS). Sûr par
      la spec : tomber en fin de fonction `void` équivaut à un
      `return;` explicite. **Piège identifié et corrigé avant même
      d'écrire le code** : `if(x)return;` (corps non accolé d'un `if`,
      lui-même dernière instruction de la fonction) ressemble token par
      token à un vrai `return;` autonome juste avant le `}` final, mais
      `if` exige syntaxiquement une instruction à sa suite — supprimer
      le `return;` laisserait `if(x)}`, GLSL invalide. Protégé en
      exigeant que `return` soit lui-même précédé d'une frontière
      d'instruction (`;`, `{`, `}`, ou début de fichier — même
      convention que `eliminate_dead_locals`/`eliminate_dead_stores`),
      que `if(x)return;` échoue (précédé de `)`). Vérifié que le piège
      résiste même quand `strip_redundant_braces` tourne avant et
      transforme `if(x){return;}` en `if(x)return;` — toujours refusé,
      testé explicitement. 6 tests Rust dédiés (suppression simple,
      fonction à un seul `return;`, refus du piège `if` non accolé,
      refus du même piège après dépouillement d'accolades, refus
      quand une autre instruction suit, refus sur `return` avec
      valeur/fonction non-void) + `fixtures/trailing_void_return.glsl`
      en parité Rust/TS/wasm (32/32) + checkbox dédiée, vérifiée en
      headless (le `if(x)return;` protégé reste intact activé ou non,
      seul le vrai `return;` final est retiré, zéro erreur console).
- ✅ **FAIT (13/07/2026) — Réduction des vecteurs constants**
      (`vec3(1.,1.,1.)` → `vec3(1.)`), 7e passe agressive
      (`aggressive.rs::reduce_constant_vectors`, miroir TS dans
      `golfer.ts`). **Sûr par la spec GLSL elle-même, pas une
      heuristique** : un constructeur de vecteur appelé avec un seul
      argument scalaire diffuse cette valeur sur chaque composante,
      donc `vecN(x)` et `vecN(x,x,...,x)` sont *par définition* la même
      valeur — pas besoin d'évaluateur d'expressions, juste une
      vérification d'égalité textuelle entre arguments. Restreint à
      `vec2`/`vec3`/`vec4` (jamais `ivec`/`uvec`/`bvec`/matrices) avec
      des arguments qui sont chacun un unique littéral numérique nu
      (jamais une expression comme `1.+0.`, jamais un littéral négatif
      — `-1.` se tokenise en `Punct('-')` puis `Number("1.")`, deux
      tokens, pas un seul, donc hors du scope volontairement étroit de
      cette passe). Tourne juste après `fold_constants` dans le
      pipeline : une constante repliée devient immédiatement éligible
      (`vec3(2*3,2*3,2*3)` → replié en `vec3(6,6,6)` → réduit en
      `vec3(6)`, testé explicitement). 6 tests Rust dédiés (réduction
      simple, refus sur valeurs différentes, refus sur argument non
      littéral, refus sur trop d'arguments, vec2/vec4, synergie avec le
      repliement de constantes) + `fixtures/constant_vectors.glsl` en
      parité Rust/TS/wasm (30/30) + checkbox dédiée dans l'UI, vérifiée
      en headless (réduit quand activée, laisse intact quand
      désactivée, stat à jour, zéro erreur console).
- [ ] Réutilisation d'un paramètre de fonction comme variable de travail
      (évite une déclaration locale)
- [ ] Constant folding étendu aux flottants (pas seulement les entiers
      `*`, `/`, `%` actuels) avec garde stricte sur la précision
- [ ] Détection de code mort **inter-instructions non adjacentes**
      (actuellement limité aux paires strictement adjacentes, documenté
      comme limite connue dans les tests)
- 🟡 **PARTIEL (14/07/2026) — Canonicalisation des espaces autour des
      opérateurs unaires ambigus.** Pas une nouvelle passe séparée : le
      mécanisme existe déjà dans `layout()` (`forms_ambiguous_pair` +
      `Item::space_before`, présent avant cette session) et fonctionne
      correctement pour tout token qui vient tel quel de la source —
      c'est ce qui garantit que `- -1.` (négation double, espace
      présente dans la source) ne devient jamais `--1.` (decrement,
      GLSL différent) au ré-assemblage. Ce qui **a été fait ici** :
      analyse explicite du risque inverse en ajoutant la 9e passe
      agressive ci-dessus (`increment_decrement`, qui *synthétise* des
      tokens `+`/`+` ou `-`/`-` adjacents plutôt que de les recopier
      depuis la source) — un token `++`/`--` fraîchement créé pourrait
      en théorie coller à un `+`/`-` déjà présent juste avant
      (`+` + `++` → un vrai compilateur C-like relirait `+++` comme
      `++` puis `+`, pas `+` puis `++`, par maximal munch). Prouvé que
      ce cas est **inatteignable** : `x+=1` ne matche que quand `x` est
      une lvalue nue (exigence de grammaire GLSL), donc le token juste
      avant `x` ne peut jamais être lui-même un `+`/`-` collé sans
      séparateur — ça ferait de `x` une sous-expression non-lvalue,
      qui n'aurait pas compilé comme cible de `+=` en premier lieu.
      Verrouillé par un test de régression dédié
      (`increment_decrement_never_collides_with_a_preceding_operator`)
      plutôt que laissé comme raisonnement informel. **Reste non fait**
      : une passe de canonicalisation générale et indépendante (utile
      si une future passe agressive venait, elle, à synthétiser des
      tokens adjacents à un endroit où cette preuve par grammaire ne
      s'applique pas) — pas de besoin identifié pour l'instant, donc
      pas construite avant d'avoir un vrai cas d'usage.
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
- ✅ **FAIT, en partie (13/07/2026) — Détection GLSL ES 1.00 vs 3.00.**
      `main.ts::detectLegacyGlslFunctions` scanne (regex à limites de
      mots, pas un vrai parseur — cohérent avec le reste du moteur
      token-heuristique) chaque passe pour `texture2D`/`textureCube`/
      `shadow2D`/`texture1D`/`texture3D` et leurs variantes `Proj`/`Lod`,
      absentes du contexte WebGL2/ES 3.00 dans lequel ce site compile
      toujours. Affiche un bandeau d'avertissement distinct (ambre, pas
      rouge — c'est un avertissement, pas une erreur de compilation)
      *avant* même de tenter de compiler, plutôt que de laisser
      l'utilisateur découvrir un message de driver "identifiant non
      déclaré" pas franchement plus parlant. **"Détecter" fait, "refuser
      proprement" pas fait** : le golf continue quand même (le bandeau
      prévient, il ne bloque rien) — refuser activement demanderait de
      décider ce que "refuser" veut dire dans une UI qui n'a pas de
      notion d'échec bloquant ailleurs. Vérifié en headless (déclenche
      bien le bandeau sur `texture2D(...)`, se retraduit correctement au
      changement de langue).
- 🟡 **PARTIEL (14/07/2026) — Gestion propre des erreurs de parsing.**
      Un vrai mode générique "je ne comprends pas cette construction"
      demanderait d'écrire un véritable validateur de grammaire GLSL
      — un projet à part entière, hors de portée en une session. À la
      place : recherche ciblée (agent dédié) pour trouver de vrais
      angles morts de correction dans le pipeline sûr *toujours actif*
      (renommage scope-aware + raccourcissement — tourne sur chaque
      shader, pas seulement derrière une case à cocher agressive, donc
      le risque y est plus grave qu'ailleurs). **Un vrai bug trouvé et
      corrigé** : un nom référencé *uniquement* à l'intérieur du corps
      d'une macro `#define` (ex. `PI` dans `#define TAU (2.0*PI)`,
      jamais utilisé comme token nu ailleurs) n'était protégé nulle
      part contre la génération d'un nouveau nom identique — les
      lignes `#define` sont conservées telles quelles et jamais
      tokenisées au-delà de leur texte brut, donc ce nom était invisible
      au balayage "protéger tout identifiant déjà présent dans la
      source". Si `NameGen` finissait par produire exactement cette
      chaîne pour une variable sans rapport, l'expansion de macro
      référencerait alors silencieusement la mauvaise variable — ou,
      pire, entrerait en collision avec la ligne de déclaration de la
      macro elle-même, produisant du GLSL invalide. `preproc_referenced_names`
      existait déjà et servait à empêcher de *renommer une déclaration*
      du même nom, mais jamais à protéger ce nom d'être *généré* comme
      nouveau nom — la moitié manquante. Corrigé des deux côtés
      (`golfer.rs::golf_with_options` + miroir TS), nouveau test Rust
      dédié + `fixtures/macro_only_reference.glsl` en parité Rust/TS/wasm
      (38/38). **Vérifié aussi et trouvés déjà sûrs** (donc non modifiés) :
      surcharge de fonctions, masquage de variable locale (shadowing),
      chaînes d'accès à des membres de struct, tableaux multi-dimensionnels
      — le renommage est du remplacement textuel par orthographe, appliqué
      uniformément à tout le fichier, donc insensible à la portée par
      construction pour ces cas-là. **Reste non fait** : le mode
      générique "avertir sur toute construction non reconnue" demandé à
      l'origine par cet item — ce qui a été livré est la correction d'un
      bug concret trouvé par investigation ciblée, pas un système de
      détection général.

### 1.3 Config / API du moteur
- ✅ **FAIT, en partie (14/07/2026) — Niveau de golf réglable.**
      Remplacé le seul bouton-case à cocher "Golf agressif" par un
      menu déroulant `<select>` à 3 niveaux (Sûr / Équilibré /
      Agressif), qui applique un préréglage aux 10 cases à cocher
      existantes plutôt que de les remplacer — le popover "⚙ Passes"
      reste utilisable pour un réglage fin, comme avant. **Pas de 4e
      niveau "max-risk"**, contrairement à ce que demandait l'item
      d'origine : décision délibérée, pas un oubli. Chaque passe
      agressive implémentée est sûre *par construction* (voir chaque
      entrée de la section 1.1) — il n'existe aujourd'hui aucune passe
      réellement plus "risquée" qu'une autre à répartir dans un 4e
      palier ; en fabriquer un artificiellement aurait suggéré une
      hiérarchie de danger qui n'existe pas. Un vrai "max-risk"
      (CSE, inlining) attendrait que ces passes existent — et elles
      ont justement été mises de côté cette session précisément parce
      qu'elles demanderaient une vraie analyse de flux de données pour
      être sûres, pas juste un badge "risqué" sur une passe déjà
      construite prudemment (voir section 1.1).
  - **Split Sûr / Équilibré / Agressif** : "Équilibré" regroupe les
    passes qui ne font jamais que réduire la taille sans changer la
    *forme* visible du code (suppression de code mort, repliement de
    constantes, réécriture d'affectations composées/incréments) ;
    "Agressif" ajoute les passes qui restructurent aussi la forme
    syntaxique (if/else → ternaire, suppression d'accolades, fusion de
    déclarations, suppression de return final) — toujours prouvées
    correctes, juste un diff visuel plus important par rapport à la
    source.
  - **Synchronisation bidirectionnelle** : sélectionner un niveau
    coche/décoche les cases correspondantes ; décocher une case
    manuellement fait basculer le menu sur une option "Personnalisé"
    cachée (présente dans le DOM, jamais choisissable directement dans
    la liste déroulante — l'équivalent pour un `<select>` de l'ancien
    état `.indeterminate` de la case à cocher maître qu'il remplace).
  - Vérifié en headless (script jetable, supprimé après usage) : niveau
    par défaut "Agressif" (cohérent avec l'ancien comportement où
    toutes les cases étaient cochées par défaut), "Sûr" décoche tout,
    "Équilibré" coche exactement le bon sous-ensemble (vérifié
    explicitement qu'il exclut les passes de forme comme les ternaires
    et les accolades), décocher une case sous "Agressif" bascule bien
    sur "Personnalisé", la recocher revient bien sur "Agressif" — 6/6.
    Plus la suite standard (tsc, eslint, build, e2e, mis à jour pour
    piloter le nouveau menu au lieu de l'ancienne case à cocher).
- ✅ **FAIT (14/07/2026) — API acceptant une whitelist de noms à ne
      jamais renommer.** Nouvelle fonction
      `golfer::golf_with_protected_names(source, aggressive_options,
      protected_names)`, `golf_with_options` devenant un simple appel
      à celle-ci avec une liste vide plutôt qu'un changement de
      signature des fonctions publiques existantes. Utile dès qu'un
      shader expose un uniform custom (nom non présent dans la liste
      figée des uniforms Shadertoy déjà protégés) qu'un binding externe
      référence par nom — sans ça, le pipeline de renommage *toujours
      actif* (pas juste le mode agressif) le renomme comme n'importe
      quel autre identifiant, cassant silencieusement ce binding.
      **Implémentation minimale par construction** : les noms protégés
      sont simplement retirés de la liste `renamable` juste après son
      calcul — ça suffit pour les deux moitiés du problème à la fois
      (le nom n'est plus jamais choisi comme cible à renommer, *et* le
      balayage existant "protéger tout identifiant déjà présent dans
      la source" (ajouté plus tôt cette session pour le bug des macros)
      le protège désormais aussi de la génération, gratuitement, sans
      code séparé). 2 tests Rust dédiés + miroir TS (`golf()` accepte
      un 3e paramètre `protectedNames`) + nouvel export wasm
      `golf_json_protected` (remplace `golf_json_ex`, devenu redondant
      — même capacités avec une liste de noms vide) + flag CLI
      `--protect NAMES` (liste séparée par des virgules) + champ texte
      dédié dans le popover de passes de l'UI, appliqué même quand
      "Golf agressif" est désactivé (le renommage n'est pas une passe
      agressive). Persisté via l'autosave existant (nouveau champ
      `protectedNames` dans `SavedProject`, rétrocompatible — un projet
      sauvegardé avant cet ajout est traité comme `""`). Vérifié
      manuellement (CLI `--protect`), en headless (jetable, supprimé
      après usage : sans protection un uniform custom est bien
      renommé, avec protection il survit tel quel et le golf compile
      toujours, la valeur du champ survit à un rechargement de page)
      + suite complète (`cargo test`, clippy avec `--features wasm`,
      parité Rust/TS/wasm 38/38, tsc, eslint, build, e2e) inchangée.
- ✅ **FAIT (13/07/2026) — Support de plusieurs buffers en une seule
      passe** (voir section 2) — mais **pas** de "renommage cohérent
      inter-fichiers" comme prévu ici à l'origine : il s'est avéré que
      ce n'est pas nécessaire (chaque buffer compile comme un programme
      GLSL séparé), donc `golf_with_options` golfe chaque buffer
      indépendamment sans aucun changement d'API. Voir la note détaillée
      en section 2.
- ✅ **FAIT (14/07/2026) — CLI : flags pour toutes les options,
      `--watch`, `--diff-only`, `--help`.** Un `--no-<passe>` par passe
      agressive (actif seulement combiné à `-a`), `--diff-only` (n'
      imprime que le résumé de stats, pas le code golfé — pas un vrai
      diff textuel : le golfé étant minifié, un diff ligne à ligne
      n'aurait pas de sens, c'est documenté explicitement dans
      `--help` plutôt que de survendre la fonctionnalité), `--watch`
      (surveillance par sondage du mtime toutes les 300ms, sans
      nouvelle dépendance — un vrai crate d'évènements filesystem
      serait plus efficace mais le sondage suffit largement pour un
      humain qui édite un shader). **Corrigé au passage** : un flag
      inconnu (ex. `--help` avant ce correctif) était silencieusement
      traité comme un chemin de fichier, produisant une erreur "fichier
      introuvable" déroutante plutôt qu'un message utile — tout
      argument commençant par `-` non reconnu échoue maintenant
      proprement avec un renvoi vers `--help`. Vérifié manuellement (
      `--help`, chaque `--no-*`, `--diff-only`, `--watch` avec un
      fichier temporaire, rejet d'un flag inconnu) + suite complète
      (`cargo test`, clippy, parité 32/32) inchangée.

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
- 🟡 **PARTIEL (14/07/2026) — Sauvegarde automatique locale du travail
      en cours.** `localStorage` plutôt qu'IndexedDB (le projet entier —
      Common, jusqu'à 4 buffers, Image, câblage iChannel — est un objet
      JSON de quelques Ko max, largement dans le budget `localStorage`
      sans la complexité asynchrone d'IndexedDB). Sauvegarde
      debounced (400ms) sur : édition de code dans l'éditeur Source,
      changement de câblage `iChannel`, changement d'onglet actif (donc
      aussi ajout/suppression de buffer, qui passent tous les deux par
      `switchTab`). Restauration au chargement de la page, **avant**
      la création de l'éditeur CodeMirror (donc le contenu initial
      affiché est déjà le bon, pas un flash du projet par défaut suivi
      d'un remplacement). Jamais fait confiance aveuglément au JSON
      stocké : validation structurelle complète (`loadSavedProject`)
      avant d'écraser le projet par défaut — un JSON corrompu, une
      ancienne forme de version précédente, ou une valeur modifiée à la
      main tombent tous silencieusement en repli sur le projet par
      défaut plutôt que de planter ou charger un état à moitié valide.
      Vérifié en headless (script jetable, supprimé après usage) : JSON
      corrompu → repli sur le défaut sans erreur console ; projet valide
      avec marqueur distinctif → restauré tel quel dans l'éditeur Source
      au chargement, compile sans bandeau d'erreur ; frappe clavier →
      écriture debounced confirmée dans `localStorage` après 900ms.
      **Reste non fait** : "plusieurs brouillons nommés" — un seul
      emplacement auto-sauvegardé, pas une UI de sauvegarde/chargement/
      suppression de brouillons multiples (unité de travail séparée et
      plus large que "ne pas perdre mon travail au rechargement").
- ✅ **FAIT, en partie (13/07/2026) — `Ctrl/Cmd+Entrée` pour golfer**
      depuis n'importe où, y compris le focus dans l'éditeur (CodeMirror
      ne réserve pas cette combinaison, donc l'événement remonte
      normalement jusqu'à l'écouteur `document`). **Palette de
      commandes façon VS Code pas faite** — un raccourci ne justifiait
      pas un système de palette entier.
- ✅ **FAIT (13/07/2026) — Taille en octets réels (UTF-8) vs
      caractères** — nouvelle statistique à côté de "car. golfés"
      (`new TextEncoder().encode(...).length`, sommée sur tous les
      buffers actifs). Pertinent dès qu'un shader contient des littéraux
      non-ASCII (rare mais possible dans un commentaire ou un nom, et le
      golf lui-même ne golfe qu'en ASCII donc les deux nombres
      coïncident presque toujours en pratique — utile surtout comme
      garde-fou visible si jamais ils divergent).
- ✅ **FAIT (14/07/2026) — Badges de formats de concours connus**
      (280/512/1024/4096/8192 octets), sous la bande de stats du
      panneau Golfé. ✓/✗ par seuil selon la taille UTF-8 déjà calculée
      pour la stat "octets golfés", tooltip donnant la marge exacte
      (dépassement en octets si ça ne rentre pas). Pas de 64k ni de
      style JS1k spécifiquement — la liste retenue couvre les cas
      réellement fréquents en golfing GLSL (shaders "tweet", 1k/4k/8k)
      plutôt que la liste exhaustive suggérée à l'origine. Se
      retraduit sans recalcul au changement de langue (même état
      mémorisé que pour le bandeau d'avertissement ES 1.00),
      vérifié en headless.

---

## 4. Viewport & rendu

- [ ] Passer le fallback WebGL1 en **WebGPU** en option (meilleure
      fidélité avec les derniers builtins GLSL/`#version 300 es`)
- [ ] Export **capture d'écran** et **enregistrement vidéo/GIF** du
      rendu golfé
- [ ] Réglages de résolution custom et pixel ratio pour tester le rendu
      "tel qu'affiché sur Shadertoy" (qui downscale parfois)
- ✅ **FAIT (14/07/2026) — Overlay d'erreurs GLSL avec ligne exacte
      surlignée dans l'éditeur.** `renderer.ts` calcule maintenant
      `bodyStartLine` (la ligne, dans la source *compilée* — en-tête
      inclus — où commence le code de l'appelant) au moment même de la
      compilation, à partir du texte réel de l'en-tête utilisé, plutôt
      que de coder en dur un nombre de lignes qui aurait pu dériver
      silencieusement si l'en-tête changeait. `main.ts` extrait le
      numéro de ligne du message driver (`ERROR: 0:N:`), soustrait
      `bodyStartLine` pour remonter à la ligne dans le code affiché, et
      surligne cette ligne via une nouvelle extension CodeMirror
      (`editor.ts::setErrorLineHighlight`, `StateField` +
      `StateEffect`). Deux cas distincts :
  - **Source cassée** (`tryCompile` sur le code brut, multi-ligne, cas
    le plus utile) — surligne dans l'éditeur Source. A demandé une
    correction supplémentaire trouvée en testant : le code compilé pour
    ce test est `common + "\n" + code`, mais l'éditeur Source
    n'affiche que `code` seul (jamais Common) — sans soustraire le
    nombre de lignes qu'occupe ce préfixe, le surlignage tombait sur la
    mauvaise ligne (repéré en testant : `}` surligné au lieu de la
    vraie ligne fautive). Corrigé (`commonPrefixLineCount()`),
    revérifié : surligne exactement la ligne contenant l'identifiant
    non déclaré dans un test délibérément cassé.
  - **Golf cassé** (le code golfé lui-même) — surligne dans l'éditeur
    Golfé. Valeur réelle plus limitée qu'annoncée : le code golfé est
    normalement une seule ligne (pas de retour à la ligne dans la sortie
    du moteur), donc le numéro de ligne calculé vaut quasiment toujours
    1 — confirme qu'il y a une erreur sans vraiment la localiser dans
    cette longue ligne, sauf si "Version justifiée" est active — et même
    alors, le calcul reste basé sur le code minifié réellement compilé,
    pas sur le texte reformaté affiché, donc le numéro peut ne plus
    correspondre visuellement une fois reformaté. Documenté en
    commentaire dans le code plutôt que caché.
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
  - ✅ **FAIT (14/07/2026) — tests e2e (Playwright) du parcours golf →
        viewport → copier.** Nouveau `web/e2e-test.mjs` : sert un vrai
        build de production (`web/dist`, pas le dev server) via un
        petit serveur HTTP local, puis pilote une page Chromium headless
        dessus. Vérifie : le shader par défaut compile sans bannière
        d'erreur, le moteur wasm est actif (pas le fallback TS), activer
        "Golf agressif" sur le shader par défaut ne casse rien, la sortie
        golfée est non vide, le compteur FPS montre une valeur positive
        (preuve que le viewport rend vraiment des frames, pas juste
        "pas d'erreur de compilation"), le clic sur "copier" ne lève
        pas d'exception, et aucune erreur console. Nouveau job `e2e`
        dans `ci.yml` (installe Chromium via
        `npx playwright install --with-deps chromium`, build, puis
        `npm run e2e`).

        Deux décisions techniques notables :
        - Le script vit dans `web/e2e-test.mjs` et non dans le
          `scripts/` à la racine (comme `parity-test.mjs`) : la
          résolution des specifiers nus ESM de Node (`import {
          chromium } from "playwright"`) part du fichier important
          lui-même, pas du `cwd` du process — `scripts/` est un
          sibling de `web/`, pas un ancêtre, donc ne pourrait jamais
          atteindre `web/node_modules/playwright`.
        - Tous les clics passent par `element.click()` exécuté via
          `page.evaluate()`, jamais par `page.click()` de Playwright.
          Cette session a découvert que la boucle `requestAnimationFrame`
          continue du viewport WebGL, combinée au rendu logiciel (pas
          de vrai GPU dans ce bac à sable ni sur les runners CI), peut
          affamer les vérifications d'actionability/stability du CDP
          de Playwright au point de faire *hang* jusqu'au timeout, même
          pour des boutons sans rapport avec le viewport. Piloter les
          clics depuis l'intérieur de la page contourne entièrement
          cette interaction CDP.

        Vérifié en local (7/7 checks) contre un vrai `npm run build`.
  - [ ] tests de non-régression visuelle (screenshot diff du viewport)
  - ✅ **FAIT (14/07/2026) — `eslint` (config plate `eslint.config.js`,
        `typescript-eslint` en mode recommended)**, `npm run lint` câblé
        en CI entre le type-check et le build. Zéro erreur au premier
        run — deux règles désactivées explicitement, chacune avec sa
        propre justification plutôt qu'un `/* eslint-disable */`
        générique : `no-non-null-assertion` (30 occurrences de `!` sur
        des `document.getElementById(...)` juste après avoir créé
        l'élément dans le même template, un garde `if (!el) throw` à
        chaque site serait du bruit pur) ; `no-explicit-any` retirée
        après coup de la config une fois vérifié qu'elle ne s'appliquait
        en fait à rien dans ce code (aucun `: any` explicite nulle
        part — la justification initiale que j'avais écrite était
        inexacte, corrigée avant de commiter).
  - ✅ **FAIT (13/07/2026) — `cargo clippy --all-targets -- -D warnings`
        en CI**, avant `cargo test` dans le même job. 7 avertissements
        trouvés au premier run local (needless_lifetimes,
        unnecessary_map_or ×3, needless_borrow, collapsible_if, et une
        fonction `lexer::tokenize` jamais appelée nulle part) — tous
        des refactors cosmétiques sans impact fonctionnel, corrigés
        (`cargo clippy --fix` pour la majorité, suppression manuelle de
        la fonction morte), retesté (`cargo test` + parité) pour
        confirmer un comportement inchangé avant de commiter.
  - ✅ **FAIT (14/07/2026) — Budget de taille de bundle en CI**, étape
        ajoutée après le build dans le job `web-build` : mesure la
        taille gzippée réelle (`gzip -c | wc -c`, pas l'estimation
        affichée par Vite) du JS et du wasm, échoue si l'un dépasse son
        budget. Budgets fixés avec une vraie marge au-dessus de la
        taille au moment de l'ajout (JS ~146,6 Ko gzippé → budget 200
        Ko ; wasm ~54,2 Ko gzippé → budget 80 Ko) plutôt que la taille
        actuelle exacte, pour attraper une vraie régression (une
        dépendance lourde ajoutée par erreur) sans faire échouer la CI
        à chaque petite croissance normale (nouvelle passe, nouvelle
        fonctionnalité UI).
  - [ ] `node scripts/wasm-check.mjs` en CI — délibérément pas ajouté
        cette fois : nécessiterait d'installer la cible
        `wasm32-unknown-unknown` + `wasm-pack` dans le job, un coût de
        temps de CI non négligeable pour un troisième niveau de parité
        déjà couvert indirectement par `cargo test` (même code source)
  - ✅ **FAIT (14/07/2026) — `cargo clippy --features wasm` en CI, trou
        de couverture réel trouvé.** Le module `wasm_api` de `lib.rs`
        est derrière `#[cfg(feature = "wasm")]`, donc le `cargo clippy
        --all-targets` déjà en CI ne le compilait jamais — et ni le job
        `e2e` ni `parity` ne compilent le wasm depuis les sources non
        plus, ils utilisent les fichiers `wasm-pkg/*` déjà commités
        (régénérés manuellement via `wasm-pack build` avant chaque
        commit qui touche cette partie). Concrètement, ce module n'était
        vérifié que par qui pensait à lancer `--features wasm` en local
        avant de commiter — repéré en ajoutant l'API de whitelist de
        noms protégés cette session (qui a supprimé `golf_json_ex` et
        ajouté `golf_json_protected`), vérifiée manuellement ce
        jour-là mais sans filet en CI. Nouvelle étape séparée dans le
        job `rust-tests`, revérifiée verte en local avant de commiter.
- [ ] Coverage rapport publié (codecov ou équivalent)
- ✅ **FAIT (14/07/2026) — Benchmarks de perf du moteur (`criterion`).**
      Nouveau `rust-core/benches/golf_bench.rs`, `cargo bench` (dev-dep
      `criterion = "0.5"`, `harness = false`). Deux groupes :
  - `fixtures/{safe,aggressive}/{fractal,swizzle_after_dot}` — golf
    safe vs agressif sur les deux plus grosses fixtures réelles
    existantes.
  - `synthetic_scaling/aggressive/{10,50,200}` — un shader généré (pas
    une fixture) avec 10/50/200 petites fonctions contenant chacune un
    local mort, une écriture morte et un vecteur constant, pour voir
    comment le temps évolue avec la taille au-delà de ce que les
    fixtures réelles (qui plafonnent à ~1,1 Ko) peuvent montrer seules.
    **Observation honnête, pas corrigée cette fois** : le passage de
    10→50→200 fonctions (×5 puis ×4 la taille) fait passer le temps
    d'environ 1,8 ms à 8,3 ms à 52 ms (×4,6 puis ×6,3) — légèrement
    super-linéaire, pas explosif, mais pas strictement linéaire non
    plus. Pas d'investigation plus poussée ni de correction : ajouter
    les benchmarks était l'objectif de cet item, pas encore le profilage
    ni l'optimisation.

      **Non fait** : pas câblé en CI — contrairement aux tests
      unitaires/parité qui ont un verdict binaire pass/fail évident,
      un benchmark de perf n'a de sens que comparé à une baseline
      stockée dans le temps (via un outil comme `critcmp` ou l'action
      GitHub dédiée), une décision d'infra distincte de "ajouter les
      benchmarks eux-mêmes". Reste utilisable manuellement en local
      (`cargo bench`) dès maintenant. Vérifié : compile et tourne
      proprement (`cargo bench -- --sample-size 10 --measurement-time 1`
      pour un run rapide de validation), `cargo test` et
      `cargo clippy --all-targets -- -D warnings` toujours propres avec
      la nouvelle dev-dependency et la nouvelle cible `[[bench]]`.

---

## 6. Accessibilité & internationalisation

- ✅ **FAIT (13/07/2026) — i18n fr/en** — voir section 3 pour le détail
      complet (`web/src/i18n.ts`), fait dans le cadre de la killer
      feature 3 de la section 9.
- ✅ **FAIT (14/07/2026) — Audit accessibilité avec un vrai outil
      (`@axe-core/playwright`), pas seulement des correctifs ad hoc.**
      Complète les correctifs manuels de la veille (`aria-live` sur les
      stats/le bandeau d'erreur, `aria-label` sur les contrôles à
      icône seule, gestion clavier du bouton de suppression de buffer)
      par un vrai audit WCAG 2.0/2.1 A+AA sur l'app construite, dans 4
      états (défaut, popover de passes ouvert, mode onglets étroit sur
      l'onglet Source, mode onglets étroit sur l'onglet Viewport).
      **3 violations réelles trouvées et corrigées** :
  - `aria-input-field-name` — les `<div>` de contenu de CodeMirror
    (éditeur Source et panneau Golfé) n'avaient aucun nom accessible.
    `editor.ts::createSourceEditor`/`createReadOnlyEditor` prennent
    maintenant un paramètre `ariaLabel`, posé sur `view.contentDOM` et
    retraduit au changement de langue.
  - `color-contrast` — le texte de la gouttière de numéros de ligne
    (`#3a4a3a` sur fond `#0c0f0b`) mesurait un ratio de 2.03:1, bien
    sous le 4.5:1 minimum WCAG AA pour du texte normal. Remplacé par
    `var(--paper-dim)`, déjà utilisé partout ailleurs dans l'app comme
    couleur de texte secondaire.
  - `scrollable-region-focusable` — le conteneur défilant de
    CodeMirror (`.cm-scroller`) n'était pas garanti accessible au
    clavier, en particulier pour le panneau Golfé en lecture seule
    (`contenteditable="false"`, que certains outils ne comptent pas
    comme focusable par défaut). `contentDOM.tabIndex = 0` posé
    explicitement dans les deux éditeurs.

      **0 violation restante** dans les 4 états testés après correctifs
      (23 règles passées, contre 21 avant). **Non fait** : test avec un
      vrai lecteur d'écran (NVDA/VoiceOver) — un outil automatisé comme
      axe-core détecte les défauts structurels/ARIA mais ne remplace
      pas un test d'usage réel.

---

## 7. Documentation & pédagogie

- ✅ **FAIT, en partie (13/07/2026) — `CHANGELOG.md`** à la racine,
      classé par date (pas de version formelle, ce projet ne publie
      rien sur un registre). Pas encore de version "0.2.0" etc. — juste
      des entrées datées Ajouté/Corrigé/Nettoyage, ce qui suffit tant
      qu'il n'y a pas de release versionnée à documenter. Pas
      d'exemples de shaders concrets par passe (viendrait naturellement
      avec le "playground de comparaison" juste en dessous, non fait).
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
