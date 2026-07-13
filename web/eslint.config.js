// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "dist-tsc/**", "node_modules/**", "src/wasm-pkg/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase leans on `!` deliberately at DOM lookup sites
      // (`document.getElementById(...)!`) where the element is known to
      // exist because it was just created in the same template literal
      // a few lines above — the alternative (an `if (!el) throw ...`
      // guard at every single one) would be pure noise here, not a
      // real safety net.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
