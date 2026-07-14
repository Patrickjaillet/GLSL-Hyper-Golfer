# NIGHTWIRE icon assets

All icons are hand-authored inline SVG (`viewBox="0 0 24 24"`, `stroke="currentColor"`
or `fill="currentColor"`), imported via Vite's `?raw` loader
(`import iconX from "./assets/icons/icon-x.svg?raw"`) and interpolated directly into
the button markup in `main.ts`. `currentColor` means each icon inherits its
button's text color, so hover/active states (Phase 1 tokens) apply for free through
CSS alone — no separate hover-state SVG file needed, per Phase 2.2's "2 states
minimum" requirement.

| File | Used by | Notes |
|---|---|---|
| `icon-mark.svg` | masthead brand badge (`.brand .mark`) | also the source for `public/brand/nightwire-mark.svg` (favicon), see below |
| `icon-run.svg` | `#run-btn` | lightning bolt, filled |
| `icon-reset.svg` | `#reset-btn` | circular refresh arrows |
| `icon-import.svg` | `#import-btn` | inbound arrow into a tray ("download to node") |
| `icon-export.svg` | `#export-btn` | outbound arrow from a tray ("upload from node") |
| `icon-passes.svg` | `#passes-btn` | sliders / config nodes |
| `icon-copy.svg` | `#copy-btn` | duplicate/copy glyph |
| `icon-pause.svg` / `icon-play.svg` | `#pause-btn` | swapped via `innerHTML` on click (paused state) |
| `icon-screenshot.svg` | `#screenshot-btn` | camera viewfinder |
| `icon-record.svg` / `icon-stop.svg` | `#record-btn` | swapped via `innerHTML` on click (recording state) |
| `icon-add.svg` | `#add-buffer-btn` | plus / new connector |
| `icon-lang.svg` | `#lang-toggle` | globe/network, paired with the FR/EN text label |
| `icon-close.svg` | `.buffer-tab-close` | small × to remove a buffer tab |
| `icon-source.svg` / `icon-golfed.svg` / `icon-viewport.svg` | `#sidebar` nav buttons | code-brackets / compression-corners / monitor glyphs |
| `icon-collapse.svg` | `#sidebar-toggle` | double-chevron, rotated 180° via CSS when `.sidebar.collapsed` |
| `icon-format.svg` | `pretty-toggle` label | indented-lines glyph ("raw vs. formatted") |
| `icon-compare.svg` | `compare-toggle` label | mirrored split-arrows glyph |
| `icon-sound-on.svg` / `icon-sound-off.svg` | `#sound-toggle` | speaker glyphs, swapped via `innerHTML` on toggle |
| `icon-badge-fits.svg` / `icon-badge-toobig.svg` | `#size-badges` (per competition size class) | circular medallion + check/cross, replaces the old `✓`/`✗` text glyphs |
| `icon-expand.svg` / `icon-shrink.svg` | `#zen-btn` | outward/inward corner arrows, swapped via `innerHTML` on toggle |

## Brand wordmark (`assets/brand/nightwire-wordmark.svg`)

The one live use of the decorative `Wallpoet` stencil face (Phase 1.2): an SVG
`<text>` reading "NIGHTWIRE" plus the same arrow glyph as `icon-mark.svg`. Imported
via `?raw` (same as the icon set, not as a CSS `background-image` — a data-URI SVG
background can't see the page's self-hosted `@font-face`, so it has to be inlined
into the DOM to actually render in Wallpoet rather than falling back to a system
font). Rendered as a faint (`opacity: 0.07`), `aria-hidden`, `pointer-events: none`
watermark rotated -90° in the sidebar's otherwise-empty vertical space
(`.sidebar-watermark`), hidden entirely once the sidebar is collapsed to icon-only.

## Decoration (`assets/decor/*.svg`)

| File | Used by | Notes |
|---|---|---|
| `decor-hex-pattern.svg` | `#sidebar` background | source-of-truth copy; CSS embeds its own inline `data:` URI copy (see below) |
| `decor-network-nodes.svg` | `.masthead::before` filigrane | connected-dots motif, tiled, `z-index: -1` so it never intercepts clicks |
| `decor-circuit-separator.svg` | `.passes-popover-sep` | replaces the plain `<hr>` — two traces meeting at a via pad |

**Why these live as both a file and an inline CSS copy**: each pattern is a couple
hundred bytes — small enough that inlining as a `background-image: url("data:...")`
in `style.css` avoids an extra network request entirely (they load with the CSS
itself, no separate GET). The `.svg` file is the documented, human-readable source
of truth for what that inline string encodes; keep them in sync if you touch one.

## Checkbox switches (passes list, `pretty-toggle`, `compare-toggle`)

Not individual SVG files — a single global `input[type="checkbox"]` rule in
`style.css` (`appearance: none` + a `::after` thumb) draws a "circuit interrupteur"
switch shared by all 12 checkboxes in the app. Twelve near-identical SVGs for the
same on/off affordance would just be duplication; the CSS switch still satisfies
"no emoji/system icon" since nothing native is rendered — everything is drawn.

## Banner glyphs (`warning-banner` / `error-banner`)

Also CSS-only: a `::before` pseudo-element with a `background-image` data-URI SVG
(triangle-exclamation for warnings, circle-alert for errors, colors baked into the
SVG to match `--amber-warn`/`--blood-red`). Chosen over touching `main.ts` because
both banners' text is set via repeated `.textContent =`/`+=` call sites — a JS-driven
icon would mean threading a child span through every one of those instead of a
zero-risk CSS addition.

## Favicon / brand mark

`public/brand/nightwire-mark.svg` is a standalone, self-colored (hardcoded hex,
not `currentColor`) variant of `icon-mark.svg` on a `--bg-void` rounded square,
linked from `index.html` as `<link rel="icon" type="image/svg+xml" ...>`.

**Deviation from ROADMAP.md 2.1**: no PNG multi-resolution favicon set
(32/64/180/512, `apple-touch-icon`, `site.webmanifest`) — this environment has no
raster/image-generation tool, only an SVG pipeline. The SVG favicon covers all
modern evergreen browsers; PNG fallbacks for old Safari/iOS home-screen icons are
not yet produced.

## Corner vias (`--circuit-vias`) and viewport cursor

Also pure CSS, no separate SVG: `--circuit-vias` (a `:root` custom property, four
`radial-gradient()` layers) draws a small pad at each corner of `.panel`,
`.viewport-wrap`, `.console-bar`, and `.sidebar`. `public/cursors/nightwire-crosshair.svg`
is a real standalone file (cursor SVGs can't use `currentColor` — same reasoning as
the favicon) applied via `cursor: url(...)` on `.viewport-frame`.

## Build-time guard (`web/check-no-emoji-icons.mjs`)

Wired into `npm run build`: fails the build if any of the emoji/glyph characters
this refactor replaced (⇩⇧⚙⏸⏹⏺📷✕▶✓✗) reappear in `main.ts`. Deliberately a small
explicit blocklist, not a broad Unicode "emoji block" sweep, which over-fires on
ordinary punctuation/symbols in translated strings and code comments.

## Not yet done (deferred, see ROADMAP.md Phase 2)

- Resizer grip icon — **N/A**, the resizers themselves were removed in Phase 4
  (obsolete in the single-view console layout).
- Masthead network-node background illustration (P1), size-badge medallions (P2),
  loader/spinner (P2), viewport frame corner reinforcements (P2).
- SVG sprite (`<symbol>`) build step (P1) — icons are currently inlined per-button
  as raw strings, which is simpler for `currentColor` theming but means the same
  markup can appear more than once in the DOM (negligible bytes at this icon
  count; revisit if the set grows much larger).
