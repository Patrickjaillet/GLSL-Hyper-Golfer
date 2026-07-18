# 🏌️ ROADMAP — Moteur de golfing : viser le plus puissant au monde

> Périmètre **strictement le moteur de golfing** (`rust-core/`, son
> miroir `web/src/golfer.ts`, et l'infrastructure de test/mesure qui le
> garantit correct) — pas l'UI, pas le thème, pas la compatibilité
> Shadertoy en tant que produit. Objectif : réduire davantage d'octets,
> sur davantage de cas, sans jamais casser un shader qui compilait
> avant. Légende : `[ ]` à faire · `[x]` fait · priorité entre
> parenthèses (P0 = gain net évident + sûr, P1 = gain réel mais
> demande plus de travail/risque, P2 = exploratoire).

---

License and Copyright:

**Hyper-Golfing Engine**
Copyright © 2026 SANDEFJORD DEVELOPMENT — All rights reserved
Creator: Patrick JAILLET
Email: contact.shaderstudio@gmail.com
Website: https://github.com/Patrickjaillet
Official Repository: https://github.com/Patrickjaillet/GLSL-Hyper-Golfer

---

Development Conventions:

- [ ] General language only English
- [ ] Theme only White or system for application
- [ ] No comments in the source code
- [ ] Every added feature must be reflected in this ROADMAP.md
- [ ] Automatic software version serialization for each Phase and each build
- [ ] Every modification must be reflected for the end-user in the CHANGELOG.md
- [ ] The README.md must be created and updated for the end-user with every modification and include a software screenshot
- [ ] Systematic synchronization with the https://github.com/Patrickjaillet/GLSL-Hyper-Golfer repository upon every project modification
- [ ] Never integrate Claude AI into GitHub, the files, or the GitHub contributors list
- [ ] Creation of all files and documents required for the GitHub repository
- [ ] Integrate copyright / Creator / Email / Website information into an "About" tab
- [ ] MIT license

---

## État des lieux (audité le 2026-07-14, avant d'écrire ce document)

Le moteur actuel (~3100 lignes Rust + miroir TS) est un **golfeur au
niveau des tokens**, pas un vrai compilateur : tokenizer maison →
renommage → raccourcissement de nombres → 10 passes "agressives"
optionnelles, chacune un motif local sur la séquence de tokens,
chacune tournant **une seule fois, dans un ordre fixe**. Pas d'AST, pas
d'arbre d'expressions, pas d'inférence de types, pas d'analyse de flux
de données au-delà de la paire de tokens adjacente. C'est un choix
délibéré et documenté (chaque passe est "sûre par construction", pas
heuristique) — mais c'est aussi ce qui plafonne mécaniquement combien
d'octets le moteur peut gagner : les plus grosses techniques de golf
(CSE, inlining, réécriture de boucles) sont hors de portée d'un
peephole tant qu'il n'a pas au moins un modèle d'expression léger.

**Déjà fait, et bien fait** (donc *hors* de cette roadmap, listé pour
éviter de le refaire) :
- Renommage **scope-aware ET classé par fréquence** (le nom le plus
  utilisé dans tout le fichier reçoit le nom généré le plus court,
  `a`,`b`,...`z`,`aa`,... base 52) — déjà l'équivalent de ce que fait
  Terser/UglifyJS en JS. Portée : function-scope (voir Phase 1.6 pour
  la limite exacte).
- 11 passes agressives (mises à jour au fil de cette roadmap) :
  élimination de locales/écritures mortes (paires adjacentes),
  repliement de constantes entières `*`/`/`/`%`/`+`/`-`, réduction de
  vecteurs constants, suppression du `return;` final, affectations
  composées, incrément/décrément préfixe, ternaire depuis if/else,
  fusion de déclarations, suppression d'accolades redondantes,
  suppression de parenthèses redondantes.
- Raccourcissement de nombres (`0.5`→`.5`, `2.0`→`2.`), mise en page à
  espacement minimal avec garde anti-fusion de tokens (`- -`≠`--`).
- Protection de noms (mots-clés, builtins, uniforms Shadertoy, liste
  blanche utilisateur, noms référencés uniquement dans un `#define`).
- Boucle à point fixe sur le pipeline agressif complet (Phase 0) et
  garde de régression de taille golfée par commit
  (`scripts/golf-size-budget.mjs`).
- 82+ tests Rust + fuzzing `proptest` (3 propriétés, ~768 cas/run,
  "ne panique jamais") + parité Rust/TS/wasm sur 20 fixtures + CI
  (clippy ×2, cargo test, parity, bundle-size budget, golf-size-budget,
  e2e Playwright).

---

## PHASE 0 — Gains gratuits (infrastructure, zéro nouvelle passe)

Avant d'écrire la moindre nouvelle passe : ce qui existe déjà peut
golfer plus fort simplement en étant mieux exploité.

- [x] (P0) **Boucle à point fixe.** Le pipeline agressif tournait
      auparavant une seule fois, dans un ordre fixe
      (`golfer.rs::golf_with_protected_names`) — désormais rejoué en
      boucle jusqu'à ce qu'aucune passe ne change plus rien (`Item`
      dérive maintenant `PartialEq` pour détecter l'absence de
      changement), plafonné à 10 itérations par garde-fou (aucune
      oscillation connue entre deux passes — chaque passe est
      individuellement non-croissante en taille — mais la limite reste
      en place au cas où). Miroir TS (`golfer.ts::itemsEqual` +
      boucle). **Cascade réelle vérifiée, pas seulement théorique** :
      `if(true){a=2.;a=3.;}` → `strip_redondant_braces` retire les
      accolades à l'itération 1, ce qui rend `a=2.;`/`a=3.;` adjacentes
      pour `eliminate_dead_stores` (qui tourne *avant* dans l'ordre
      fixe, donc ne les voyait jamais dans un seul passage) —
      confirmé à la main via le CLI (`-a`), la première écriture est
      bien éliminée à l'itération 2. Parité Rust/TS/wasm toujours
      38/38 + 64 tests Rust inchangés + `cargo clippy` (×2, avec/sans
      `--features wasm`) propre.
- [x] (P0) **Comparatif automatisé avant/après par commit.**
      `scripts/golf-size-budget.mjs` : golfe chaque fixture (CLI Rust
      release, niveau "Agressif" complet), somme les octets UTF-8,
      compare à une baseline committée
      (`scripts/golf-size-baseline.json`, régénérée via `--update`) et
      échoue si le total régresse — même esprit que le budget de taille
      de bundle JS déjà en place. Branché en CI dans le job `parity`
      (qui construit déjà le CLI release). Baseline initiale : **3396
      octets** au total sur les 19 fixtures existantes, capturée
      *après* la boucle à point fixe ci-dessus (donc le point de départ
      inclut déjà ce gain, pas un total pré-Phase-0 périmé). Vérifié
      que la détection de régression échoue bien (test manuel : baisse
      artificielle de la baseline de 100 octets → échec avec message
      explicite, restauré ensuite).
      **`cargo bench` (`benches/golf_bench.rs`) reste non branché en
      CI** — mesure la vitesse d'exécution, pas la taille golfée ; hors
      du périmètre de cet item, qui porte sur le *résultat* du golf,
      pas sa performance d'exécution (voir Phase 5 pour un futur suivi
      de perf si besoin).
- [x] (P1) **Tableau de bord de progression.** `scripts/golf-progress-dashboard.mjs`
      (script, pas d'UI, comme demandé) — deux modes.
      **Mode rapide (défaut)** : relit l'historique déjà committé de
      `scripts/golf-size-baseline.json` (un commit par item de cette
      roadmap qui touche la puissance de golfing) et calcule, en plus du
      total brut, un total "sous-ensemble commun" restreint aux fixtures
      présentes à *chaque* commit de l'historique — pour ne pas
      confondre "golfe mieux" avec "teste plus" quand le corpus grossit.
      **Un vrai piège trouvé en construisant cette métrique, pas
      seulement anticipé** : même le sous-ensemble commun peut *grossir*
      dans le temps, non pas parce que le moteur golfe moins bien, mais
      parce que le **texte source** d'une fixture existante est étendu
      avec de nouvelles lignes (ex. `constant_folding.glsl` allongée en
      Phase 1.1) — un total plus gros pour le même nom de fixture ne
      prouve donc rien sur la puissance du moteur à lui seul. Documenté
      explicitement dans la sortie du mode rapide plutôt que laissé
      comme un biais silencieux.
      **Mode rigoureux (`--replay`)**, ajouté pour cette raison précise :
      reconstruit le binaire CLI Rust tel qu'il existait à chaque commit
      historique (via un `git worktree` jetable, un `cargo build
      --release` par commit) et le fait tourner sur les fixtures
      **actuelles, gelées** — isolant la seule variable qui compte
      vraiment (le moteur golfe-t-il le *même* texte en moins d'octets
      avec le temps) du bruit de croissance du corpus. Plus lent (un
      build Rust complet par commit, ~15-30s chacun), donc optionnel.
      **Chiffres réels obtenus en exécutant le mode `--replay`, pas
      inventés** : sur les 24 fixtures actuelles, les 7 commits de
      l'historique de `golf-size-baseline.json`
      (`5d2b7fa`→`76ef4fc`) golfent respectivement **4596 → 4522 → 4526
      → 4504 → 4431 → 4431 → 4407 octets**, soit **-4.1% net** sur le
      même corpus figé. Résultat honnête, pas cherry-picked : un item
      (`740bc20`, comparaison décimal/scientifique) montre même une
      légère régression locale (+4 octets) sur ce corpus précis avant
      que l'item suivant ne la recouvre largement — cohérent avec "Notes
      de méthode" ci-dessous (mesurer plutôt qu'affirmer). Rapport
      généré committé dans `PROGRESS.md` (régénérable à volonté, pas
      maintenu à la main).

---

## PHASE 1 — Nouvelles passes sûres par construction (même esprit que les 10 actuelles)

Chaque item ci-dessous doit rester dans le régime "prouvable
statiquement / garanti par la spec GLSL", **pas** heuristique — c'est
ce qui a fait la qualité du moteur jusqu'ici, à ne pas sacrifier pour
aller plus vite.

### 1.1 Repliement de constantes — étendre la couverture actuelle
- [x] (P0) **Opérateurs `+`/`-` entre littéraux entiers.** Nouvelle
      fonction `fold_additive_constants` (`aggressive.rs` + miroir
      `foldAdditiveConstants` dans `golfer.ts`), branchée sur le même
      interrupteur `fold_constants` (pas une case à cocher séparée —
      c'est toujours conceptuellement "repliement de constantes", en
      plus large). Plie des chaînes `1+2+3` → `6`, `3-5` → `-2`, signe
      unaire de tête inclus (`-5+3` → `-2`).
      **La vraie raison pour laquelle `+`/`-` avait été exclu n'était
      pas le signe unaire mais la précédence** : contrairement à
      `*`/`/`/`%` (déjà la précédence la plus serrée, donc jamais
      "volée" par le contexte), un `+`/`-` textuel peut être le
      *dernier terme* d'une multiplication qui le précède (`2*3+2` où
      le `3` ne doit jamais être plié seul avec le `2` suivant) — géré
      en refusant de démarrer une chaîne si le token juste avant est
      `*`,`/`,`%`,`+` ou `-`, et en arrêtant l'extension de la chaîne
      si le token juste après un terme candidat est `*`,`/` ou `%`
      (le terme "appartient" alors à la multiplication suivante, pas à
      la chaîne additive — laissé tel quel, `fold_constants` le pliera
      séparément et la **boucle à point fixe de la Phase 0** repliera
      le reste à l'itération suivante : synergie directe entre les
      deux items).
      **Un vrai bug trouvé et corrigé par test manuel, pas seulement
      raisonné à l'avance** : la première version traitait "précédé
      d'un identifiant/nombre/`)`/`]`" comme une frontière sûre pour le
      cas "signe unaire de tête" — faux : `x-1+2` (où `x` est une
      variable) a produit du GLSL invalide (`c 1` — tokens disparus)
      avant correction, parce que le `-` y est en réalité *binaire*
      (`x` moins `1`), pas un signe unaire de tête. Corrigé en excluant
      aussi identifiant/nombre/`)`/`]` de la frontière sûre — vérifié
      que `x-1+2` reste désormais intact, et que le même raisonnement
      protège aussi contre un signe unaire *doublé* (`- -3+2`, où la
      précédence de l'unaire face au binaire `+` rendrait un repliement
      naïf faux : `(-(-3))+2=5`, jamais `-(-3+2)=1`).
      Gardes overflow (`checked_add`/`checked_sub` + bornes `i32`)
      identiques à `fold_constants`. 9 nouveaux tests Rust dédiés
      (chaîne simple, chaîne à 3+ termes, signe de tête, refus si
      précédé d'une variable, refus si précédé de `)`/`]`, refus si le
      terme suivant appartient à une multiplication, refus du signe
      doublé, refus overflow, composition avec `fold_constants` via la
      boucle à point fixe) + fixture `constant_folding.glsl` étendue,
      parité Rust/TS/wasm 38/38 inchangée, budget de taille (Phase 0) :
      **3396 → 3394 octets** sur le corpus existant (petit gain sur les
      fixtures actuelles, qui ne comportent pas beaucoup de `+`/`-`
      constants — le vrai gain se verra sur de vrais shaders), puis
      **3394 → 3464 octets** après extension de la fixture elle-même
      (nouveau contenu testé, pas une régression).
- [x] (P1) **Repliement flottant, avec garde de précision stricte.**
      Nouvelles fonctions `fold_float_constants` (`*`, même scan glouton
      gauche-à-droite que `fold_constants`) et
      `fold_additive_float_constants` (`+`/`-`, même logique de chaîne
      et de frontière sûre que `fold_additive_constants`) dans
      `aggressive.rs`, miroir TS `foldFloatConstants`/
      `foldAdditiveFloatConstants` dans `golfer.ts`, branchées sur le
      **même interrupteur** `fold_constants` (toujours pas une case à
      cocher séparée — même raisonnement que le repliement `+`/`-`
      entier de l'item précédent). `/` volontairement exclu comme
      prévu. Restreint aux littéraux simples : point décimal explicite
      obligatoire, ni notation scientifique (`1e5`), ni suffixe `f`/`u`
      — `parse_plain_float`/`parsePlainFloat` refusent tout le reste.
      **L'argument de précision réellement utilisé, plus simple que ce
      que cet item envisageait à l'origine** : au lieu de calculer en
      `f64` puis vérifier un round-trip vers `f32`, le calcul se fait
      **directement en `f32` natif** (arithmétique IEEE-754
      correctement arrondie de Rust), exactement ce que la spec GLSL
      exige d'un compilateur `highp` pour `+`/`-`/`*` — hôte et GPU
      calculent donc bit à bit la même chose par construction, la même
      confiance dans la spec que le reste du moteur accorde déjà à
      l'arithmétique entière 32 bits. Le round-trip texte↔valeur reste
      vérifié dans `format_folded_float`/`formatFoldedFloat` (garde bon
      marché, jamais censée échouer vu ce qui précède, mais gratuite).
      Cas refusés explicitement et testés : résultat non fini (overflow
      vers l'infini), et **zéro négatif** (`-0.0-0.0` par ex. — un signe
      `-` devant un `0` de magnitude nulle est un cas limite trop rare
      pour la complexité de le gérer correctement ; la chaîne entière
      est laissée intacte plutôt que repliée à moitié).
      **Écart réel entre Rust et TS, documenté plutôt que caché** :
      JavaScript n'a pas de type `f32` natif — `foldFloatOp` émule via
      `Math.fround` après chaque opération native (f64), ce qui est
      mathématiquement exact pour `+`/`-`/`*` entre deux valeurs `f32`
      (le résultat exact tient toujours dans la précision `f64`, donc
      `Math.fround` du résultat exact donne le même arrondi unique que
      le matériel `f32`) — mais **l'analyse du texte source vers un
      `f32` de départ** (`Number.parseFloat` texte→f64, puis
      `Math.fround` f64→f32) est un double-arrondi qui peut, dans des
      cas extrêmement rares (une valeur décimale posée quasiment
      exactement à mi-chemin entre deux `f32`), diverger d'une
      conversion décimal→f32 directe correctement arrondie (ce que fait
      `str::parse::<f32>()` côté Rust). Accepté comme risque résiduel
      documenté plutôt que résolu : ce moteur TS n'est jamais que le
      repli de secours si le wasm ne charge pas, et ce genre de
      littéral est quasi inexistant dans un shader écrit à la main.
      14 nouveaux tests Rust dédiés (multiplication simple, chaîne de
      multiplications, chaîne additive, résultat négatif, signe unaire
      de tête, refus si précédé d'une variable, refus de la division,
      refus de la notation scientifique/suffixe, refus overflow, refus
      zéro négatif, composition mult→add via point fixe, `0.1+0.2`
      calculé en `f32` — le piège classique de précision décimale,
      vérifié qu'il donne bien `0.3` comme le ferait le GPU) + 2 tests
      préexistants mis à jour (pas des régressions : l'un affirmait
      explicitement "le repliement flottant est totalement absent",
      obsolète par construction ; l'autre utilisait des littéraux
      flottants pour tester une passe différente —
      `strip_redundant_parens` — et a dû être changé pour des variables
      afin de continuer à isoler ce qu'il teste réellement).
      Fixture `constant_folding.glsl` étendue (8 nouvelles lignes
      couvrant les mêmes cas). Parité Rust/TS/wasm 40/40, `cargo test`
      et `cargo clippy` (×2) propres, budget de taille (Phase 0) :
      **3657 → 3732 octets** (nouvelles lignes de fixture, pas une
      régression sur l'existant). Suite web complète vérifiée (`tsc`,
      `eslint`, `vite build`, `e2e`) — verte, mais **budget de bundle
      wasm gzippé notablement plus proche de sa limite** après cet
      item : ~56.6 KiB → ~70.8 KiB (budget CI : 80 KiB), parce que le
      formatage/parsing `f32` "arrondi correctement, round-trip
      garanti" tire des bouts non triviaux de la stdlib Rust (Grisu/
      Dragon côté formatage) qui n'étaient jamais liés au binaire tant
      que seul l'entier était golfé. Toujours sous le budget CI, mais à
      surveiller : peu de marge reste pour d'autres items de cette
      roadmap qui ajouteraient à leur tour du code stdlib lourd.
- [x] (P1) **Notation numérique optimale — comparer les représentations,
      garder la plus courte.** `shorten_number`/`shortenNumber`
      comparent désormais la forme décimale déjà produite à une forme
      scientifique équivalente et gardent la plus courte des deux —
      `1000000.` (8 car.) devient `1e6` (3 car.), `.0001` (5 car.)
      devient `1e-4` (4 car.), mais `123456.` (7 car.) reste décimal
      face à `1.23456e5` (9 car., plus long) : comparaison stricte de
      longueur, pas une préférence a priori pour l'une ou l'autre
      forme. Sur une égalité exacte de longueur (`.000123` vs
      `1.23e-4`, 7 caractères chacun), le décimal gagne (comparaison
      `<` stricte, pas `<=`) plutôt que de changer de forme sans gain
      réel.
      **Garde critique, trouvée par raisonnement avant d'écrire le
      code, pas par un bug en production** : cette comparaison ne
      s'applique **que si le littéral est déjà typé `float`** (contient
      un `.` avant tout raccourcissement) — un entier nu comme
      `1000000` ne doit jamais devenir `1e6`, ce qui changerait
      silencieusement son type GLSL d'`int` vers `float` (cassant par
      exemple une taille de tableau ou un compteur de boucle qui exige
      un `int`), alors même que la valeur numérique reste identique.
      Testé explicitement (`never_converts_a_bare_integer_to_scientific_notation`).
      Restreint aux littéraux qui n'ont pas déjà leur propre exposant
      (`1.5e10` reste inchangé par cette comparaison — en retrouver un
      exposant plus court est hors du périmètre de cette première
      version).
      **Écart Rust/TS supplémentaire, documenté comme celui du
      repliement flottant** : Rust utilise `{value:e}` (déjà le plus
      court texte scientifique qui round-trippe exactement, même
      garantie que `{value}` pour la forme décimale). JavaScript n'a
      pas d'équivalent : `Number.prototype.toExponential()` est calibré
      pour un `f64`, pas un `f32` — testé concrètement, il donne des
      résultats bien plus longs et complètement différents pour une
      valeur qui est en réalité un `f32` (`0.0001` en `f32` :
      `toExponential()` natif donne `"9.999999747378752e-5"` quand le
      texte correct le plus court est `"1e-4"`). Contourné en TS par une
      recherche par force brute : essayer un nombre croissant de
      chiffres significatifs via `toExponential(n)` et garder le
      premier qui round-trippe exactement (`Math.fround` d'un nombre
      f32 n'a jamais besoin de plus de 9 chiffres significatifs) —
      vérifié que cette approche reproduit exactement les mêmes choix
      que Rust sur une douzaine de valeurs de test avant de l'intégrer.
      6 nouveaux tests Rust dédiés (grand nombre entier→scientifique,
      petite fraction→scientifique, forme décimale gardée quand plus
      courte, égalité stricte gardant le décimal, entier nu jamais
      converti, littéral à exposant déjà présent laissé intact, suffixe
      de type correctement reporté) + 1 test existant mis à jour (pas
      une régression : un très grand littéral flottant golfe désormais
      en `1e30` par le pipeline sûr avant même que la passe agressive
      ne s'exécute, ce qui la rend de toute façon non repliable pour
      une seconde raison indépendante — `parse_plain_float` refuse tout
      littéral à exposant). Fixture `numbers_and_ambiguity.glsl`
      étendue avec les mêmes cas. Parité Rust/TS/wasm 40/40, `cargo
      test`/`cargo clippy` (×2) propres, budget de taille (Phase 0) :
      **3732 → 3787 octets** (nouvelles lignes de fixture, pas une
      régression sur l'existant). Suite web complète vérifiée — verte,
      budget de bundle wasm gzippé continue de se resserrer (~70.8 KiB
      → ~73.0 KiB sur un budget CI de 80 KiB, même cause que l'item
      précédent : plus de code de formatage/parsing `f32` correctement
      arrondi désormais lié dans le binaire).
- [ ] (P2) **Constantes GLSL `const` scalaires simples.** Propager la
      valeur d'un `const float PI=3.14159;` dans les usages qui suivent
      **seulement** si strictement adjacent au même schéma de sûreté
      que le reste du moteur (jamais de vraie analyse de flux
      inter-blocs) — évaluer d'abord si le gain (permettre au
      repliement de constantes de "voir à travers" un `const`) justifie
      la complexité avant de s'engager dessus.

### 1.2 Nettoyage syntaxique supplémentaire
- [x] (P0) **Suppression des parenthèses redondantes.** Nouvelle
      fonction `strip_redundant_parens` (`aggressive.rs` + miroir
      `stripRedundantParens` dans `golfer.ts`), nouvel interrupteur
      dédié `strip_redundant_parens` (case à cocher séparée dans l'UI,
      contrairement au repliement `+`/`-` de 1.1 qui partage
      l'interrupteur existant — ici il s'agit d'une passe structurelle
      distincte, pas d'une extension d'une passe déjà cochable). Retire
      `( expr )` quand `expr` est un unique `scan_primary` — safe dans
      **tout** contexte sans analyse de précédence, puisqu'un primaire
      est déjà l'unité la plus liante de la grammaire (contrairement au
      repliement `+`/`-` de 1.1, qui a dû raisonner sur la précédence
      des voisins). Refuse quand le `(` est précédé d'un identifiant —
      une seule vérification qui exclut à la fois les vrais appels de
      fonction (`foo(x)`) et les parenthèses obligatoires des mots-clés
      de contrôle GLSL (`if(a)`, `while(a)`, `for(...)`, `switch(a)`),
      puisque les mots-clés se tokenisent comme le même type `Ident`
      qu'un identifiant normal dans ce lexer. `return(a)` reste donc
      aussi non touché par prudence, bien que techniquement sûr.
      Composé avec la **boucle à point fixe de la Phase 0** : `((1.))`
      se réduit en deux itérations, une couche à la fois.
      **Un vrai bug trouvé et corrigé par test manuel** : la première
      version supprimait le `(`/`)` sans ajuster l'espacement, et
      `5.-(-x)` produisait `5.--c` — les deux `-` (celui de `5.-` et le
      signe unaire de `x`) se retrouvaient adjacents sans espace
      séparateur, alors que la garde anti-fusion de `layout()`
      (`AMBIGUOUS_PAIRS`/`forms_ambiguous_pair`) ne se déclenche que sur
      le `space_before` d'origine du token — un flag qui reflète
      l'intention de la source *avant* golfing, pas les nouvelles
      adjacences créées en supprimant des tokens. Corrigé en forçant
      `space_before=true` sur le premier token réémis après suppression
      des parenthèses (ce qui ne fait que faire *tourner* la
      vérification anti-fusion, sans jamais insérer un espace inutile
      quand aucune fusion n'est réellement possible — vérifié sur
      `5.*(-x)` → `5.*-c` sans espace, `*-` n'étant pas une paire
      ambiguë). Vérifié à la main : `5.-(-x)` → `5.- -c` (espace
      présent), `5.+(+x)` → `5.+ +c` (idem), `(1.)` → `1.`, `((1.))` →
      `1.` via point fixe, `if((true))` conserve les parenthèses
      obligatoires du `if` tout en repliant `(true)` en `true` à
      l'intérieur (deux mécanismes indépendants qui interagissent
      correctement).
      10 nouveaux tests Rust dédiés (parenthèses autour d'un littéral
      simple, imbrication via point fixe, refus autour d'une expression
      binaire, refus autour d'un opérande utilisé dans une
      multiplication, refus d'un vrai appel de fonction, refus des
      parenthèses obligatoires d'un mot-clé de contrôle, régression
      d'espacement signe-unaire-moins, idem signe-unaire-plus, non-ajout
      d'espace superflu quand aucune fusion n'est possible) + fixture
      `parens.glsl` créée (8 parenthèses redondantes supprimées dessus,
      2 blocs d'accolades supprimés en bonus par interaction avec les
      passes existantes) + un test préexistant mis à jour (pas une
      régression : `y=(x+=1.0);` golfe maintenant en `y=++x;` plutôt
      que `y=(++x);`, la nouvelle passe reconnaissant correctement que
      les parenthèses autour d'un `++x` post-réécriture sont
      redondantes). `cargo test --all-targets` et `cargo clippy`
      (×2, avec/sans `--features wasm`) propres. **Bug de plomberie
      wasm trouvé et corrigé au passage** : `lib.rs::golf_json_protected`
      (l'export wasm-bindgen utilisé par l'UI) n'avait jamais reçu le
      nouveau champ `strip_redundant_parens` — `cargo clippy --features
      wasm` a immédiatement échoué à la compilation (`E0063` : champ de
      struct manquant), ce que la variante clippy sans wasm ne pouvait
      pas détecter puisque ce module entier est `#[cfg(feature =
      "wasm")]`. Corrigé (nouveau paramètre + champ dans
      `AggressiveOptions`), miroir `wasmGolfer.ts` mis à jour en même
      temps (même ordre de paramètres). Parité Rust/TS 40/40 et
      Rust/wasm 40/40 (wasm reconstruit via `wasm-pack build --target
      web --release --features wasm`), budget de taille (Phase 0) :
      baseline mise à jour à **3657 octets** sur 20 fixtures (nouvelle
      fixture `parens.glsl` incluse, aucune régression sur les
      fixtures déjà existantes). Suite web complète vérifiée : `tsc
      --noEmit`, `eslint`, `vite build` (budget de bundle inclus), `e2e`
      Playwright — tous verts. Case à cocher UI ajoutée
      (`pass-parens`, groupe "Agressif" uniquement, pas "Équilibré") :
      légère tension avec le "pas l'UI" du périmètre de ce document,
      mais nécessaire pour que la passe soit réellement activable/
      désactivable par l'utilisateur, au même titre que les 10 passes
      existantes qui suivent toutes ce même schéma une-case-par-passe.
- [x] (P1) **Suppression des qualificateurs de précision redondants.**
      **Recherche faite avant d'écrire du code, comme demandé, et elle a
      changé le périmètre de l'item** : la version large envisagée à
      l'origine ("le contexte WebGL2/ES 300 fournit peut-être déjà une
      précision par défaut") s'est révélée fausse et dangereuse — les
      spec GLSL ES 1.00 *et* 3.00 (section "Default Precision
      Qualifiers") sont explicites : un fragment shader n'a **aucune**
      précision par défaut pour `float`. Une instruction `precision
      <qualif> float;` (ou un qualificatif équivalent par déclaration)
      est **obligatoire**, pas une commodité que le compilateur
      applique en son absence. Le renderer de *cette app*
      (`renderer.ts`) injecte bien son propre en-tête `precision highp
      float;` avant chaque shader compilé, ce qui peut faire paraître
      "redondante" une instruction que l'utilisateur aurait écrite
      lui-même — mais le moteur de golfing n'a aucun moyen de savoir ou
      de garantir ça pour l'environnement où le code golfé finira
      réellement (un contexte WebGL2 nu, un autre hôte façon Shadertoy,
      un fichier `.frag` autonome). Supprimer la seule instruction de
      précision pour un type effectivement utilisé casserait
      silencieusement la compilation dès que le code quitte l'aperçu de
      cette app — exactement le genre de régression que "Notes de
      méthode" ci-dessous interdit. **Version large explicitement
      déclinée**, pas implémentée comme heuristique "généralement sûre".
      **Ce qui reste sûr sans aucune hypothèse sur la destination** :
      supprimer une redéclaration **strictement identique** d'un
      qualificatif déjà en vigueur pour le même type — sémantiquement
      un no-op garanti par la spec elle-même. Nouvelle fonction
      `strip_duplicate_precision` (`aggressive.rs`, avec son propre
      interrupteur dédié `strip_duplicate_precision`, case à cocher UI
      incluse comme les autres passes structurelles) + miroir TS
      `stripDuplicatePrecision`. **Pas un cas hypothétique pour cette
      app spécifiquement** : `main.ts::golfProject` concatène le code
      Common (qui déclare souvent la précision une fois) devant le
      corps de chaque buffer avant de golfer (ROADMAP.md Phase 4) — un
      buffer qui redéclare aussi la même précision (par prudence, ou
      copié d'ailleurs) produit exactement ce doublon.
      6 nouveaux tests Rust dédiés (doublon exact supprimé, triplon
      réduit à un seul, instruction unique jamais touchée, qualificatif
      différent conservé, type différent conservé) + fixture dédiée
      `duplicate_precision.glsl`. Parité Rust/TS/wasm 42/42, `cargo
      test`/`cargo clippy` (×2) propres, budget de taille (Phase 0) :
      **3787 → 3902 octets** (nouvelle fixture, pas une régression sur
      l'existant). Suite web complète vérifiée — verte, budget de
      bundle wasm gzippé stable (~73.0 → ~72.8 KiB, aucune croissance
      notable cette fois, contrairement aux deux items précédents —
      cette passe n'a besoin d'aucun code stdlib supplémentaire).
- [x] (P1) **Élimination de fonctions mortes.** Nouvelle fonction
      `eliminate_dead_functions` (`aggressive.rs`, interrupteur dédié
      `eliminate_dead_functions`, case à cocher UI incluse, groupe
      "Agressif" comme les autres passes structurelles) + miroir TS
      `eliminateDeadFunctions`. Repère chaque définition de fonction au
      niveau global (`<type> <nom>(...){...}` — la seule forme possible
      à ce niveau : un corps de `struct` n'est jamais précédé d'une
      `)`, et un bloc de contrôle comme `if(...){...}` ne peut jamais
      apparaître hors d'un corps de fonction en GLSL valide, donc aucune
      exclusion de mot-clé supplémentaire n'est nécessaire ici,
      contrairement à `strip_redundant_parens`), construit le graphe
      d'appel (tout identifiant connu apparaissant dans le corps d'une
      fonction = un appel vers elle), puis fait un parcours
      d'atteignabilité depuis `main`/`mainImage` (celui qui existe
      réellement). Tout ce qui n'est jamais atteint est supprimé
      entièrement — signature et corps.
      **Garde critique, la même famille de risque que celle trouvée
      pour les qualificateurs de précision** : cette passe se **désactive
      entièrement** si ni `main` ni `mainImage` n'est défini dans le
      fichier — un buffer Common golfé seul (Phase 4) ne contient que
      des fonctions utilitaires, aucun point d'entrée à lui ; sans
      racine connue, tout serait "jamais atteint" et la passe
      supprimerait silencieusement du code de bibliothèque légitime.
      Décliner est toujours sûr ; deviner un point d'entrée ne l'est
      pas. Testé explicitement
      (`declines_entirely_when_there_is_no_recognized_entry_point`).
      **Deux fonctions de même nom (surcharge GLSL légale par type de
      paramètres) sont suivies comme un seul nœud du graphe d'appel et
      gardées ou supprimées ensemble** — cette passe n'a aucune
      information de type pour savoir quelle surcharge un site d'appel
      résout réellement, donc traiter le nom comme atteint dès qu'un
      appel existe est le choix conservateur et toujours sûr (au pire
      une surcharge réellement morte survit à côté d'une vivante ;
      jamais l'inverse). Testé
      (`keeps_all_overloads_of_a_reachable_name`).
      Vérifié explicitement que le parcours est une vraie atteignabilité
      transitive et pas seulement "quelque chose l'appelle-t-il
      directement" : une paire mutuellement récursive (`deadA` appelle
      `deadB`, `deadB` appelle `deadA`) mais jamais atteinte depuis
      `mainImage` est bien supprimée **en entier**, pas seulement la
      moitié qui n'a "aucun appelant" au sens naïf
      (`removes_a_mutually_recursive_pair_thats_unreachable_from_any_entry_point`).
      6 nouveaux tests Rust dédiés (fonction jamais appelée supprimée,
      fonction appelée directement gardée, fonction atteinte seulement
      transitivement gardée, paire mutuellement récursive mais
      inatteignable supprimée en entier, surcharges toutes gardées
      ensemble, aucun point d'entrée → passe entièrement désactivée) +
      fixture dédiée `dead_functions.glsl`. Parité Rust/TS/wasm 44/44,
      `cargo test`/`cargo clippy` (×2) propres, budget de taille (Phase
      0) : **3902 → 4050 octets** (nouvelle fixture, pas une régression
      sur l'existant). Suite web complète vérifiée — verte, mais
      **budget de bundle wasm gzippé désormais nettement plus proche de
      sa limite** : ~72.8 → ~76.0 KiB sur un budget CI de 80 KiB (marge
      restante ~5.9 KiB, ~7%) — cette passe elle-même n'ajoute que peu
      de code, l'essentiel de la croissance vient de `HashMap`/`HashSet`
      désormais réellement exercés dans le binaire wasm optimisé. **À
      surveiller de près avant tout item futur qui ajouterait encore du
      code** (Phase 2 en particulier, qui introduit un vrai modèle
      d'expression) — le budget CI devra probablement être relevé, ou
      la taille du binaire wasm activement travaillée, avant d'aller
      beaucoup plus loin.

### 1.3 Renommage — pousser la portée plus loin
- [x] (P1) **Renommage au niveau du bloc, pas seulement de la
      fonction.** `function_scope_ranges` remplacé par
      `block_scope_tree` (`golfer.rs`, miroir TS `blockScopeTree`) : au
      lieu de ne connaître que le corps de chaque fonction, calcule
      l'arbre complet de tous les `{...}` imbriqués à n'importe quelle
      profondeur (corps de `if`/`for`/`while`/`do`, ou bloc nu) — un
      `for(int i=...)` étend sa propre portée pour inclure son
      en-tête, exactement comme `extend_left_to_params` le faisait déjà
      pour les paramètres de fonction, appliqué récursivement à
      n'importe quelle profondeur plutôt qu'au seul niveau supérieur.
      `Scope::Local` devient `Local(Vec<usize>)` (avant : un seul
      indice de fonction) : deux déclarations de la **même** orthographe
      dans des portées **mutuellement disjointes** (`mutually_disjoint`
      — aucune ne contient l'autre, testé par comparaison de bornes,
      pas d'analyse de chevauchement générale nécessaire puisqu'un
      arbre de blocs propre n'a jamais de chevauchement partiel)
      peuvent maintenant partager le même nouveau nom court — l'exemple
      moteur de l'item (`tempResult` dans un `if`, `otherThing` dans le
      `else` disjoint) fonctionne, mais aussi un gain plus large et
      plus fréquent en pratique : la **même** orthographe réutilisée
      (typiquement un compteur de boucle `i`) dans deux `for` disjoints
      de la même fonction, ou un même nom de paramètre générique (`x`,
      `p`) répété dans plusieurs fonctions indépendantes — ce dernier
      cas était déjà silencieusement raté par l'ancien modèle
      (silencieusement forcé en Global dès que 2+ déclarations
      distinctes existaient, quel que soit leur niveau) et se golfe
      maintenant correctement en Local partagé.
      **Un vrai bug trouvé par test manuel, pas seulement raisonné à
      l'avance, et qui aurait cassé des shaders réels s'il n'avait pas
      été attrapé** : la première version ne vérifiait la collision
      qu'en remontant la chaîne des ANCÊTRES d'une portée — mais
      l'ordre d'assignation des noms est piloté par la fréquence
      d'usage, pas par l'ordre de l'arbre, donc une portée DESCENDANTE
      (le compteur `i` d'une boucle `for`) peut très bien être décidée
      *avant* la portée ANCÊTRE qui la contient (l'accumulateur `s` de
      la fonction) — vérifier seulement "mes ancêtres ont-ils déjà ce
      nom" ne voit jamais ce que ses propres DESCENDANTS ont déjà pris.
      Résultat concret avant correction : `float s=0.;for(int
      i=0;...){s+=...;}for(int i=0;...){s+=...;}` golfait en `float
      a=0.;for(int a=0;...)a+=...;for(int a=0;...)a+=...;` — `s` et le
      compteur de boucle `i` fusionnés sous le **même** nouveau nom, une
      vraie collision entre deux variables différentes. Corrigé en
      vérifiant la disjonction mutuelle contre **toutes** les portées
      déjà décidées à ce stade (pas seulement les ancêtres), ce qui
      fonctionne quel que soit l'ordre de traitement.
      6 nouveaux tests Rust dédiés (réutilisation à travers un if/else
      disjoint, réutilisation d'un compteur de boucle à travers deux
      `for` disjoints, régression explicite de la collision
      ancêtre/descendant ci-dessus, refus de réutiliser à travers une
      vraie chaîne d'imbrication à 3 niveaux, réutilisation à travers
      trois blocs frères disjoints) + fixture dédiée
      `block_scope_renaming.glsl` + 2 tests préexistants mis à jour (pas
      des régressions : le renommage est maintenant meilleur — un nom
      de paramètre partagé entre deux fonctions indépendantes libère
      une lettre courte pour `mainImage` lui-même, changement de sortie
      attendu et vérifié). Parité Rust/TS/wasm 46/46, `cargo
      test`/`cargo clippy` (×2) propres, budget de taille (Phase 0) :
      **4050 → 4298 octets** (nouvelle fixture, pas une régression sur
      l'existant — plusieurs fixtures existantes golfent en réalité
      *mieux* qu'avant grâce à la réutilisation de paramètres à travers
      les fonctions, confirmé absence de régression individuelle par
      `golf-size-budget.mjs`). Suite web complète vérifiée — verte,
      mais **budget de bundle wasm gzippé désormais critique** : ~76.0
      → ~78.6 KiB sur un budget CI de 80 KiB (marge restante ~3.3 KiB,
      **~4%**). **Traité immédiatement après** (voir l'entrée dédiée
      juste en dessous) plutôt que reporté — l'utilisateur a
      explicitement choisi d'investir dans une vraie réduction de la
      taille du binaire avant de continuer, plutôt que de relever le
      budget CI ou de laisser filer.

- [x] **(hors-item, traité immédiatement) Réduction réelle de la taille
      du binaire wasm.** Investigation demandée par l'utilisateur suite
      au constat ci-dessus. `opt-level="z"` + `lto=true` +
      `codegen-units=1` + `panic="abort"` étaient déjà en place ; ajouté
      `strip=true` + un `wasm-opt` explicite (`-Oz
      --enable-bulk-memory`) dans `[package.metadata.wasm-pack.profile.release]`
      — gain mesuré : quasi nul (78580 → 78527 octets gzip, wasm-pack
      appliquait déjà un niveau d'optimisation équivalent par défaut).
      Profilé avec `twiggy top` (nécessite un build de diagnostic avec
      `-g` pour garder les noms de fonctions, jamais utilisé pour le
      binaire livré) : les plus gros postes sont `golf_with_protected_names`
      lui-même (32 Ko, légitime — c'est tout le pipeline), le formatage
      `f32`/`flt2dec` (dragon/grisu, ~19 Ko cumulés — nécessaire à la
      garantie de précision des Phases 1.1, jamais touché), et
      `serde`/`serde_json` (~3.6 Ko directement attribuables, plus une
      partie non négligeable du code généré par les macros `#[derive]`
      non individuellement affichée par `twiggy`).
      **Action retenue : remplacer `serde`/`serde_json` par une
      sérialisation JSON écrite à la main**, réservée à la seule
      surface wasm (`lib.rs::wasm_api`) qui en avait besoin — le CLI
      natif n'a jamais utilisé JSON. Forme, ordre des champs et
      camelCase reproduits exactement (vérifié par un test dédié
      comparant au texte JSON exact que produisait `serde_json` avant
      la bascule, capturé comme référence figée). Un échappement JSON
      manuel gère le seul champ qui peut réellement contenir des
      guillemets/antislashs/caractères de contrôle : `code`, quand une
      ligne `#pragma`/`#define` (conservée verbatim, jamais retokenisée)
      en contient — testé avec un vrai run-trip via `JSON.parse` côté
      Node en plus des tests Rust dédiés. `serde`/`serde_json` retirés
      entièrement de `Cargo.toml` (plus aucun consommateur dans le
      crate). **Gain réel et net** : 175551 → 159698 octets bruts
      (-9%), **78580 → 75007 octets gzip (-4.5%)** — la marge sous le
      budget CI de 80 Ko remonte de ~3.3 Ko (~4%) à **~6.9 Ko (~8.5%)**,
      à peu près doublée. 3 nouveaux tests Rust dédiés (forme JSON
      exacte contre la référence figée, échappement des caractères
      spéciaux, round-trip réel via `JSON.parse`), `cargo test
      --features wasm` (seul mode où ce module compile) et `cargo
      clippy` (×2) propres, `cargo test`/`clippy` sans le flag wasm
      également propres (le module `wasm_api` entier est
      `#[cfg(feature="wasm")]`, invisible sinon). Parité Rust/TS/wasm
      46/46 inchangée (cette bascule ne touche que la sérialisation, pas
      le golfing lui-même — confirmé par `golf-size-budget.mjs` : "No
      change vs. baseline", exactement le résultat attendu). Suite web
      complète vérifiée, y compris `e2e` qui exerce le vrai chemin
      wasm→JSON→UI de bout en bout, pas seulement les tests Rust
      isolés.
- [ ] (P2) **Réutilisation d'un paramètre de fonction comme variable de
      travail** (évite de déclarer une nouvelle locale quand un
      paramètre n'est plus lu après un certain point) — nécessite la
      même analyse de durée de vie que 1.3 ci-dessus pour être sûr.

### 1.4 Vecteurs et types composés
- [x] (P1) **Étendre `reduce_constant_vectors` aux valeurs repliées
      d'expressions simples**, pas seulement aux littéraux nus déjà
      identiques textuellement.
      **Déjà satisfait par construction dès que Phase 1.1 a été
      implémentée** : `fold_float_constants`/`fold_additive_float_constants`
      tournent déjà *avant* `reduce_constant_vectors` dans la même
      itération de la boucle à point fixe (Phase 0) — vérifié
      explicitement (`vec3(2.0+1.0,2.0+1.0,2.0+1.0)` golfe déjà en
      `vec3(3.)`) plutôt que supposé, avec 2 nouveaux tests Rust dédiés
      qui pinnent cette composition.
      **Un vrai gap trouvé en creusant l'item, pas seulement vérifié** :
      `vec4(1000000.0+0.0, 1000000.0, 1000000.0, 1000000.0)` golfait en
      `vec4(1000000.,1e6,1e6,1e6)` — **pas réduit**, malgré 4 valeurs
      identiques. Cause : `format_folded_float` (Phase 1.1) produisait
      le premier argument replié sous forme décimale brute (`1000000.`)
      sans jamais le comparer à la notation scientifique, alors que les
      3 autres littéraux *non repliés* passaient par `shorten_number`
      (qui, lui, fait cette comparaison) et devenaient `1e6` — même
      valeur, deux orthographes différentes, donc la vérification
      d'égalité textuelle de `reduce_constant_vectors` voyait 4
      arguments "différents". Corrigé en factorisant
      `shortest_scientific_form` (déplacée de `golfer.rs` vers
      `aggressive.rs`, dont `golfer.rs::shorten_number` importe
      désormais la version partagée) et en l'appliquant aussi dans
      `format_folded_float` — un résultat replié reçoit maintenant
      exactement le même traitement "décimal vs scientifique, garder le
      plus court" qu'un littéral brut de la source. Bonus vérifié :
      `vec2(0.00005+0.00005, 0.0001)` réduit désormais correctement en
      `vec2(1e-4)` (composition replier→raccourcir→réduire sur trois
      passes différentes).
      2 nouveaux tests Rust dédiés au gap trouvé (le cas `vec4` exact,
      et un cas supplémentaire avec une petite fraction) + fixture
      dédiée `constant_vector_from_folded_values.glsl`.
      **Parité Rust/TS cassée puis corrigée en cours de route — la
      partie la plus significative de cet item** : le miroir TS
      *déclinait* silencieusement le repliement de `1000000.0+0.0`
      entièrement (pas seulement le défaut de raccourcissement
      ci-dessus) parce que `Token` en TS n'a qu'un seul champ `text`
      (mutable, réécrit par le renommage/raccourcissement de la
      pipeline sûre) là où `Item` en Rust distingue `tok` (le token
      lexé, jamais modifié) de `text` (le rendu courant) — les fonctions
      de repliement TS lisaient `.text`, qui par le moment où la passe
      agressive tourne a déjà été raccourci en `1e6` par
      `shortenNumber`, et `parsePlainFloat` refuse à raison tout
      littéral à exposant (indiscernable d'un `1e6` que l'utilisateur
      aurait écrit lui-même, hors périmètre de Phase 1.1) — donc plus
      aucun repliement ne partait jamais pour ce littéral en TS, alors
      que Rust repliait correctement (il lit toujours `item.tok`, jamais
      affecté par le raccourcissement de `item.text`). Corrigé en
      ajoutant un champ `original` à `Token` (miroir exact de
      `Item.tok`) : rempli une fois par le tokenizer et jamais réécrit
      ensuite ; les 4 sites de lecture `parsePlainInt`/`parsePlainFloat`
      basculés de `.text` vers `.original` ; les ~19 sites de
      construction de tokens synthétiques (repliement, réécritures
      ternaire/incrément/fusion) mis à jour pour porter `original` égal
      à leur propre `text` fraîchement calculé — le compilateur
      TypeScript a servi de checklist exhaustive (erreur systématique
      sur tout site oublié), aucune omission possible. Trouvé par le
      test de parité sur la fixture ci-dessus, pas par relecture : 47/48
      avant correction, 48/48 après.
      Parité Rust/TS/wasm 48/48, `cargo test`/`cargo clippy` (×2)
      propres, budget de taille (Phase 0) : **4298 → 4407 octets**
      (nouvelle fixture, pas une régression sur l'existant). Suite web
      complète vérifiée — verte.

---

## PHASE 2 — Fondation architecturale : sortir du peephole pur

**Prérequis explicite** pour tout ce qui suit en Phase 3. Le corpus de
règles ci-dessous (CSE, inlining, réécriture de boucles) a été identifié
dans l'ancienne roadmap comme "hors de portée d'une session" précisément
parce que le moteur n'a aujourd'hui aucune structure au-dessus de la
liste de tokens. Ne pas tenter ces passes en peephole pur — le risque de
bug de correction monte fort dès qu'on sort du motif "deux tokens
adjacents".

- [x] (P0) **Modèle d'expression léger.** Nouveau module `expr.rs`
      (aucun équivalent existant à remplacer) : un vrai analyseur
      descendant récursif à précédence d'opérateurs, produisant un
      arbre (`Expr`/`ExprKind` : `Number`, `Ident`, `Unary`, `Binary`,
      `Ternary`, `Call`, `Index`, `Member`, `Paren`) avec les bornes
      exactes (`start`/`end`, indices dans le flux de tokens) de chaque
      nœud — construit sur les mêmes primitives que le peephole existant
      (`scan_primary`, `skip_balanced`, désormais `pub(crate)` pour être
      partagées). Précédence C/GLSL standard via *precedence climbing*
      (une seule fonction générique plutôt que 12 fonctions récursives
      empilées) ; opérateurs deux caractères (`==`,`&&`,`<<`,...)
      reconnus par adjacence sans espace, même convention que
      `space_before` du lexer pour distinguer un vrai `--` de deux `-`
      unaires séparés par un espace.
      **Périmètre volontairement restreint, documenté plutôt que
      découvert plus tard** : ni affectation, ni opérateur virgule
      (jamais nécessaires pour les sous-expressions valeur que cible la
      Phase 3), et surtout **jamais `++`/`--`** — un opérateur à effet de
      bord ne peut jamais être traité comme un sous-terme pur
      dupliquable/réordonnable par une future passe de CSE sans casser
      le programme ; les exclure ici est le choix de sûreté correct, pas
      un raccourci.
      **Deux vrais bugs trouvés par les tests, pas anticipés à l'écriture** :
      (1) un opérateur en position finale sans opérande valide derrière
      (`a+`) faisait échouer l'analyse de **toute** l'expression via `?`
      au lieu de simplement s'arrêter en gardant `a` comme plus longue
      expression valide trouvée — corrigé en un `break` au lieu d'une
      propagation d'échec ; (2) un `++`/`--` **postfixe** juste après un
      terme complet (`x++ + 1`) aurait fait consommer un seul des deux
      `+` comme opérateur binaire en laissant l'autre en suspens,
      corrompant silencieusement la frontière `.end` — corrigé en
      refusant explicitement cette paire adjacente plutôt que de
      retomber sur la reconnaissance à un seul caractère.
      **Pas de miroir TypeScript pour l'instant, décision délibérée** :
      ce module n'a aucun appelant (la Phase 3 sera son premier
      consommateur) — écrire un miroir TS maintenant, sans que rien
      n'exerce les deux implémentations l'une contre l'autre, reproduirait
      exactement le risque de divergence silencieuse trouvé et corrigé en
      Phase 1.4 (`item.text` vs `item.original`). Le miroir TS arrivera
      avec la première passe de Phase 3 qui consomme réellement ce
      modèle, en même temps que le changement de comportement observable
      qu'elle introduit — jamais avant.
      19 tests Rust dédiés (précédence multiplicative/additive,
      associativité gauche, opérateurs deux caractères, associativité
      droite du ternaire, préservation des parenthèses comme nœud,
      chaînes membre/index/appel, appels imbriqués, préfixes unaires
      chaînés, `- -x` avec espace ≠ `--x`, refus explicite de `--x`,
      arrêt propre avant `x++`, parenthèse non fermée refusée,
      opérateur final refusé proprement, égalité structurelle
      ignorant spans/parenthèses pour le futur CSE, robustesse sur
      entrée vide/aléatoire). `cargo test`/`cargo clippy` (×2) propres.
      Budget de taille (Phase 0) : **aucun changement** (module non
      branché dans le pipeline).
- [x] (P0) **Analyse de liveness intra-fonction.** `eliminate_dead_stores`
      généralisée depuis "seulement la paire adjacente" vers un vrai
      calcul de liveness sur toute la portion de code linéaire (bloc
      droit, sans branchement) : `parse_write_chain` regroupe désormais
      une chaîne maximale d'écritures simples consécutives, puis
      `find_dead_writes_in_chain` cherche pour chaque écriture, dans
      *toute* la chaîne (pas seulement l'écriture suivante), la
      prochaine écriture vers le même nom et vérifie qu'aucune écriture
      entre les deux (RHS bornée à un identifiant nu, `rhs_ident`) ne
      relit la valeur — exactement la généralisation "code mort non
      adjacent" que l'ancienne roadmap listait comme limite connue.
      Reste strictement dans le régime "preuve, pas heuristique" : tout
      ce qui n'est pas une écriture simple reconnue (branchement,
      boucle, appel, affectation composée) arrête la chaîne net, rien
      au-delà n'est jamais analysé — pas de fusion de branches, pas de
      vraie analyse de flux de contrôle façon CFG, délibérément, dans
      le même esprit que le reste du moteur.
      Exemple concret débloqué : `x=1.0;y=2.0;x=3.0;` — auparavant non
      détecté (le `y=2.0;` intercalé empêchait la paire adjacente de
      matcher, quel que soit le nombre d'itérations du point fixe) —
      golfe désormais en `y=2.;x=3.;`, le premier `x=1.0;` correctement
      identifié comme mort.
      **`eliminate_dead_locals` non touchée** : elle raisonne déjà sur
      la fréquence globale du nom dans tout le fichier (pas sur un
      point de programme précis), donc déjà maximalement générale pour
      ce qu'elle fait — une vraie généralisation par liveness n'aurait
      rien à y ajouter.
      2 tests Rust mis à jour (pas des régressions : un ancien test
      documentait explicitement l'ancienne limite comme scope
      *intentionnel* — devenu obsolète par construction — remplacé par
      un test positif de la nouvelle capacité, plus un test négatif
      dédié confirmant qu'une vraie lecture intercalée (`y=x;`) bloque
      toujours correctement la suppression). Miroir TypeScript
      (`parseWriteChain`/`findDeadWritesInChain`/`eliminateDeadStores`)
      réécrit en parallèle dans le même changement — parité Rust/TS
      48/48, `cargo test`/`cargo clippy` (×2) propres. Fixture
      `dead_stores.glsl` étendue avec le cas non-adjacent ci-dessus *et*
      son pendant refusé (`p=1.0;q=p;p=3.0;` — `q=p;` lit réellement `p`,
      la suppression doit rester refusée), budget de taille (Phase 0) :
      **4407 → 4428 octets** (nouvelles lignes de fixture, pas une
      régression sur l'existant — 4 suppressions d'écritures mortes sur
      cette seule fixture contre 3 avant cet item). Suite web complète
      vérifiée (`tsc`, `eslint`, `vite build`, `e2e`) — verte, wasm
      reconstruit et reparité 48/48.
- [x] (P1) **Graphe d'appel de fonctions.** Nouveau module `callgraph.rs` :
      extrait et généralise la logique de graphe d'appel que
      `eliminate_dead_functions` (Phase 1.2) construisait en interne
      pour son seul besoin (un `HashSet` de callees par fonction, juste
      assez pour la question "atteignable oui/non"). `CallGraph`
      généralise vers un compte d'appels par callee (`HashMap` au lieu
      de `HashSet`) — la question "combien de fois", prérequis direct
      de l'inlining à site d'appel unique (Phase 3.2), que la seule
      atteignabilité ne peut pas répondre. `find_function_definitions`/
      `FunctionDef`/`matching_open_paren` déplacées avec lui (même
      module, cohérence : on ne peut pas construire un graphe d'appel
      sans d'abord trouver les fonctions). `eliminate_dead_functions`
      refactorée pour consommer `CallGraph::reachable_from` au lieu de
      sa propre copie du parcours d'atteignabilité — **refactor à
      comportement strictement identique**, vérifié par le budget de
      taille (Phase 0, aucun changement) et la parité 48/48.
      **Un vrai bug trouvé par les tests du nouveau compte d'appels, pas
      par relecture** : le nom de la fonction dans sa propre signature
      (`void helper(){...}`) tombait dans la même plage de tokens
      scannée pour trouver ses appelants, donc chaque fonction se
      comptait implicitement comme s'appelant elle-même une fois — sans
      effet sur la seule atteignabilité (un self-loop ne change rien à
      un ensemble déjà atteint), mais faussant silencieusement de +1
      *tout* futur usage de `total_calls_to` (Phase 3.2 aurait vu
      "appelée 2 fois" pour une fonction réellement appelée une seule
      fois, bloquant à tort l'inlining). Corrigé en excluant
      explicitement l'indice du nom de fonction (`def_start+1`) du
      scan de son propre corps.
      **`total_calls_to` n'a pas encore d'appelant** (Phase 3.2 sera le
      premier) — même raisonnement que le modèle d'expression ci-dessus
      pour ne pas écrire un miroir TS prématuré ; `reachable_from`, lui,
      a déjà un appelant réel (`eliminate_dead_functions`) donc est
      déjà exercé par la suite de tests existante à travers lui.
      4 nouveaux tests Rust dédiés au module (compte de multiples
      appels vers la même fonction, somme à travers plusieurs appelants
      distincts, atteignabilité transitive via `reachable_from`, une
      fonction jamais appelée a bien un compte total de zéro). `cargo
      test`/`cargo clippy` (×2) propres, budget de taille (Phase 0) :
      **aucun changement** (refactor pur). Suite web complète vérifiée
      — verte, wasm reconstruit et reparité 48/48.
      **Total après Phase 2** : 144 tests Rust (était 120 avant cette
      phase), parité Rust/TS/wasm 48/48 inchangée, budget wasm gzippé
      stable (~76.5 KiB sur 80 KiB de budget CI, aucune croissance
      notable — aucun de ces trois items n'ajoute de code stdlib
      lourd, contrairement aux items de formatage `f32` de Phase 1.1).

---

## PHASE 3 — Passes qui nécessitent la fondation de Phase 2

Chaque item ici doit rester mesuré, pas juste "appliqué dès que
possible" — plusieurs de ces techniques peuvent **agrandir** le code
dans certains cas (voir notes) et ne doivent tourner que quand elles
réduisent effectivement la taille nette.

- [ ] (P1) **Élimination de sous-expressions communes (CSE), sous
      condition de gain net mesuré.** Golfer veut souvent l'inverse
      d'un compilateur classique : dupliquer une expression est parfois
      plus court que déclarer une variable temporaire pour la
      partager (`float x=1,y=1;` vs `#define Q 1` vs dupliquer `1`
      deux fois — le point de bascule dépend du nombre d'occurrences
      et de la longueur de l'expression). Implémenter comme : détecter
      les sous-expressions identiques répétées (via le modèle
      d'expression de Phase 2), **calculer** le coût en octets de
      chaque stratégie (dupliquer / variable / macro), choisir la plus
      courte — jamais appliquer aveuglément.
- [ ] (P1) **Inlining de fonctions à site d'appel unique.** Une
      fonction appelée exactement une fois (via le graphe d'appel de
      Phase 2) peut être collée en ligne à son site d'appel, économisant
      la déclaration de fonction elle-même (nom, accolades, `return`)
      contre le coût de substituer les paramètres. Mesurer le gain net
      avant d'appliquer (une fonction avec plusieurs paramètres complexes
      référencés plusieurs fois dans le corps peut perdre à l'inlining).
- [ ] (P1) **Extraction de swizzles répétés en temporaire, sous
      condition de gain net mesuré.** Même logique de calcul de coût
      que le CSE ci-dessus, cas spécifique aux accès `.xyz`/`.rgba`
      répétés sur une même expression complexe.
- [ ] (P1) **Golfing via macros `#define` générées automatiquement.**
      Technique classique de la scène démo, absente aujourd'hui : si une
      expression assez longue apparaît assez de fois, la remplacer par
      un `#define` à une seule lettre peut battre à la fois la
      duplication et une variable (pas de déclaration de type, pas de
      portée à respecter). Le moteur protège déjà correctement les noms
      référencés *dans* un `#define` existant (Phase précédente,
      `preproc_referenced_names`) — cette passe est le sens inverse :
      *générer* un `#define` plutôt que se contenter d'en protéger un
      existant. Même calcul de coût net que CSE/swizzle.
- [ ] (P2) **Réécriture d'idiomes vers builtins plus courts, dans les
      deux sens.** Ex. `x*x` (3 car.) est plus court que `pow(x,2.)`
      (10 car.) — le sens inverse de ce qu'on pourrait attendre
      ("utiliser les builtins" n'est pas toujours golfé plus court).
      Répertorier les paires idiome↔builtin GLSL courantes et choisir
      systématiquement la forme la plus courte *par construction*
      (identité mathématique garantie par la spec, pas une heuristique
      de style).
- [ ] (P2) **Réécriture de boucles `for`/`while` vers la forme
      équivalente la plus courte.** Nécessite de comparer les formes
      côte à côte (le fondation de Phase 2 aide à isoler proprement le
      corps de boucle) et de garantir l'équivalence exacte des
      conditions de sortie — le point le plus délicat à prouver sûr de
      toute cette roadmap, à traiter en dernier une fois le reste
      stabilisé.

---

## PHASE 4 — Optimisation spécifique multi-buffer / Shadertoy

Le seul écart trouvé entre "correct" et "optimal" dans la gestion
multi-passe actuelle : chaque buffer golfe indépendamment, y compris
le code **Common**, dupliqué textuellement dans chacun
(`main.ts::golfProject()`, `common + "\n" + p.state.code` par passe).
Ce n'était pas un bug de correction (chaque buffer Shadertoy compile
comme un programme séparé, rien n'exige de renommage cohérent entre
eux) — mais c'est un angle mort réel pour la **taille totale
combinée**, jamais mesuré ni optimisé jusqu'ici.

- [ ] (P1) **Exposer le coût réel de la duplication de Common dans les
      statistiques.** Aujourd'hui le total affiché est la somme des
      tailles golfées par passe — ce qui inclut N copies (potentiellement
      différemment renommées) du même Common. Calculer et afficher
      séparément "octets Common" × "nombre de passes qui l'utilisent"
      comme part du total, pour que l'utilisateur sache où va le
      budget avant même d'essayer de l'optimiser.
- [ ] (P2) **Détection de fonctions dupliquées entre buffers.** Si un
      buffer redéclare une fonction textuellement identique à une
      autre déjà présente dans un buffer différent (ou dans Common),
      le signaler — proposer de la migrer vers Common (une seule
      déclaration golfée au lieu de N) plutôt que la fusionner
      automatiquement (changer le texte source d'un buffer sans
      confirmation explicite est le genre de changement qu'il vaut
      mieux proposer, pas imposer).
- [ ] (P2) **Golf conscient du budget de taille.** Les paliers de
      compétition existent déjà comme *affichage* (280B/512B/1k/4k/8k,
      `SIZE_CLASSES`) mais le moteur golfe toujours vers le minimum
      absolu, jamais "vers le palier suivant atteignable" — un mode
      optionnel qui accepterait de désactiver une passe *risquée pour
      la lisibilité mais pas nécessaire* dès que le palier visé est
      déjà atteint serait une fonctionnalité différenciante réelle pour
      qui golfe spécifiquement pour un concours à taille fixe.

---

## PHASE 5 — Sûreté et infrastructure de confiance (condition de tout ce qui précède)

Chaque phase ci-dessus qui sort du régime "peephole prouvable" (Phases
2-4 en particulier) a besoin d'un filet de sécurité proportionnellement
plus solide — le moteur actuel n'a jamais eu besoin de ça parce que
chaque passe existante est individuellement triviale à raisonner.

- [ ] (P0) **Étendre le fuzzing au-delà de "ne panique jamais".** La
      propriété actuelle (`fuzz_robustness.rs`) est délibérément
      faible (pas d'évaluateur GLSL disponible pour prouver
      l'équivalence sémantique complète) — mais un filet intermédiaire
      est possible sans écrire un évaluateur complet : **compiler**
      (pas exécuter) le shader golfé avec un vrai compilateur/validateur
      GLSL (`glslang`, disponible en Rust/CLI) sur le corpus de
      fixtures avant/après chaque nouvelle passe, et échouer si le
      golfé ne compile plus alors que la source compilait. Ce n'est
      toujours pas une preuve sémantique, mais ça attrape toute une
      classe de bugs ("golfé produit du GLSL syntaxiquement invalide")
      qu'aucun test actuel ne couvre directement en dehors des
      fixtures manuelles.
- [ ] (P1) **Comparaison de rendu pixel avant/après, sur les fixtures
      qui ont un rendu visuel** (celles utilisées par l'app web,
      `fixtures/fractal.glsl` etc.) — rendre la version source et la
      version golfée avec le même moteur WebGL déjà présent dans l'app
      (`web/src/renderer.ts`), comparer pixel par pixel. C'est la
      vérification la plus proche d'une vraie preuve d'équivalence
      sémantique disponible sans écrire un évaluateur GLSL complet, et
      elle est spécifiquement pertinente pour attraper une régression
      de *précision* (repliement flottant de Phase 1.1, par exemple) —
      une différence de valeur trop petite pour casser la compilation
      mais visible à l'écran.
- [ ] (P1) **Score de confiance par passe, cette fois réellement
      justifié.** L'ancienne roadmap avait explicitement refusé cet
      item ("aucune passe n'est plus risquée qu'une autre aujourd'hui")
      — vrai pour les 10 passes peephole existantes, plus vrai du tout
      dès que CSE/inlining/réécriture de boucles (Phase 3) existent :
      ces passes-là sortent du régime "prouvé par construction" vers
      "prouvé sous conditions mesurées". Distinguer dans l'UI/les stats
      quelles passes sont garanties par la spec vs. mesurées empiriquement
      sûres sur le corpus de test.
- [ ] (P1) **Corpus de shaders réels golden.** Toujours une décision
      légale/éditoriale de l'utilisateur (licence des shaders
      Shadertoy récupérés) — mais l'infrastructure d'ingestion peut être
      préparée à l'avance : un script qui prend une liste d'URLs/IDs
      Shadertoy (déjà l'API d'import existe côté UI), golfe chaque
      shader avec chaque niveau, et rapporte taille avant/après/par
      passe, prêt à recevoir un vrai corpus dès que l'utilisateur en
      fournit un.
- [ ] (P2) **Comparatif contre d'autres minifieurs GLSL connus** (ex.
      les golfeurs npm existants, s'ils sont accessibles/installables)
      sur le même corpus de fixtures — la seule façon de vérifier
      objectivement l'affirmation "le plus puissant au monde" plutôt que
      de la déclarer sans preuve.

---

## Notes de méthode (à respecter pour chaque nouvel item ci-dessus)

- **Jamais de régression de correction pour un gain d'octets.** Une
  passe qui golfe plus mais casse ne serait-ce qu'un shader qui
  compilait avant doit être reculée, pas gardée "parce que ça golfe
  mieux en moyenne" — c'est le principe qui a gouverné les 10 passes
  existantes et qui doit continuer à gouverner celles-ci.
- **Mesurer avant d'implémenter à l'aveugle.** Plusieurs items ci-dessus
  (CSE, swizzle, macros générées) peuvent *perdre* des octets selon le
  contexte — la règle n'est jamais "appliquer dès que le motif matche"
  mais "appliquer seulement quand le calcul de coût net est positif".
- **Un test dédié + une fixture par nouvelle passe**, même standard que
  l'existant (voir `fixtures/*.glsl` et les tests colocalisés dans
  `golfer.rs`/`aggressive.rs`) — pas d'exception pour "c'est juste une
  petite passe".
- **Parité Rust/TS obligatoire** avant de merger quoi que ce soit —
  `scripts/parity-test.mjs` doit rester vert, le moteur TS n'est pas un
  citoyen de seconde zone (c'est le repli réel si le wasm ne charge
  pas, pas un simple outil de dev).
