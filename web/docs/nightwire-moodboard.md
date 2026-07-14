# NIGHTWIRE — Moodboard & cadrage (Phase 0)

Nom de code du thème : **NIGHTWIRE**. Utilisé dans les commentaires CSS
(`/* NIGHTWIRE: ... */`) et les noms de fichiers d'assets
(`nightwire-logo.svg`, `nightwire-noise.png`, etc.).

## Références visuelles (Darkweb / Dark-Coder)

- **Terminal clandestin** : fond quasi noir, texte mono vert acide ou
  ambre-rouge, curseur bloc clignotant, prompt `root@nightwire:~#`.
- **Onion routing / réseau underground** : diagrammes de nœuds reliés
  par des traits fins, points lumineux aux intersections, latence
  visible (paquets qui "voyagent").
- **Matrix rain** : colonnes de glyphes qui tombent en fond très discret
  (opacité faible, jamais au premier plan, jamais derrière le texte
  actif) — réservé aux zones vides / écrans de chargement.
- **Câblage circuit imprimé** : bordures de panneaux traitées comme des
  pistes de PCB, avec pastilles (vias) aux coins et intersections.
- **Glitch / CRT** : légère aberration chromatique sur hover des
  boutons primaires, scanlines très subtiles en overlay plein écran
  (opacité ~3%, `mix-blend-mode: overlay`), jamais sur le texte pour
  garder la lisibilité.
- **Glyphes cyrilliques/hex décoratifs** : utilisés uniquement en
  arrière-plan décoratif (motifs SVG répétés), jamais comme texte
  fonctionnel — accessibilité avant tout.
- **Bruit de grain** : texture PNG de grain fin, superposée à
  `--bg-void`, opacité ~4%.

## Palette figée

Voir `web/src/style.css` (Phase 1) — `--bg-void`, `--bg-panel`,
`--bg-raised`, `--line`, `--line-glow`, `--text-primary`, `--text-dim`,
`--acid-green`, `--blood-red`, `--signal-violet`, `--amber-warn`.
Aucune variante claire, aucun sélecteur de thème.

## Écrans / états existants à recréer (inventaire depuis `web/src/main.ts`)

1. **Écran principal — onglet Source** : éditeur de code, tabs de
   buffers (Common/Buffer A-D/Image), rangée de canaux iChannel,
   sélecteur de niveau de golfing, boutons Import Shadertoy / Export /
   Passes / Réinitialiser / Exécuter le golfing.
2. **Écran principal — onglet Golfé** : éditeur de sortie en lecture
   seule, toggle "pretty print", bouton Copier, bloc de mesures
   (réduction totale, jauge à ticks, compteurs caractères/octets/
   identifiants renommés/nombres raccourcis), badges de taille,
   statistiques du mode agressif, statistiques par passe.
3. **Écran principal — onglet Viewport** : canvas WebGL temps réel,
   HUD fps/résolution, contrôles pause/capture d'écran/enregistrement
   vidéo, mode comparaison side-by-side (source vs golfé).
4. **Popover "Passes"** : liste de checkboxes (10 passes), champ
   "noms protégés".
5. **Bandeaux d'état** : bandeau d'avertissement, bandeau d'erreur
   (`aria-live="assertive"`).
6. **Mode comparaison** : deux viewports côte à côte avec labels
   "source" / "golfé".
7. **État "enregistrement"** : bouton d'enregistrement actif (capture
   vidéo WebM en cours), bouton capture d'écran (PNG).
8. **Sélecteur de langue** : bascule FR/EN dans le masthead.
9. **Sélecteur de niveau de golfing** : Safe / Balanced / Aggressive.
10. **Redimensionneurs** (`resizer-1`, `resizer-2`) entre les panneaux.
11. **Barre d'onglets** (tab-bar) source/golfé/viewport — navigation
    mobile-first actuelle à remplacer par la nouvelle composition
    (Phase 4).

## Décision de disposition (remplace la Phase 0 point 5)

Abandon de la disposition actuelle en 3 colonnes fixes sans scroll
("banc de labo"). Nouvelle composition définie en Phase 4 de la
roadmap : structure entièrement différente, pensée autour d'un layout
"console" avec panneaux empilables/rétractables plutôt que 3 colonnes
rigides.

## Validation visuelle

Pas d'export figé (image de référence) produit à ce stade — ce projet
n'a pas d'outil de génération d'images intégré au flux de travail.
Validation faite directement sur les premiers écrans codés en Phase 1
et 4 (revue itérative dans le navigateur), plutôt que sur maquettes
statiques préalables.
