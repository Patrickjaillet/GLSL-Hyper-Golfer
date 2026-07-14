// SVGO config for NIGHTWIRE's hand-authored icon/decor/brand/cursor SVGs
// (ROADMAP.md Phase 9). `removeViewBox` is disabled deliberately: every
// icon is sized purely via CSS (no explicit width/height attributes), so
// stripping the viewBox would break scaling entirely, not just bloat.
export default {
  multipass: true,
  plugins: [
    {
      name: "preset-default",
      params: {
        overrides: {
          removeViewBox: false,
        },
      },
    },
  ],
};
