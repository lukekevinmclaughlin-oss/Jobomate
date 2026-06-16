// Flat ESLint config (ESLint 9). Lints the renderer (src/) and Electron main (electron/).
// Focus: catch real bugs as errors; keep stylistic / boundary-`any` items as warnings so the gate
// stays green on this established codebase without churning intentional patterns.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-electron/**",
      "release/**",
      "node_modules/**",
      "bin/**",
      "obj/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ["electron/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Repo-wide rule posture: bugs are errors; intentional boundary patterns are warnings.
    rules: {
      // The engine/IPC boundaries legitimately traffic in untyped JSON; `any` is intentional there.
      "@typescript-eslint/no-explicit-any": "off",
      // Allow `_`-prefixed unused args (event handlers, IPC signatures) but flag real dead bindings.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Empty catch blocks are used deliberately for best-effort cleanup; require a comment instead.
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "@typescript-eslint/no-empty-function": "off",
      // ANSI/terminal escape stripping legitimately matches control characters in a regex.
      "no-control-regex": "off",
      // The Electron tsconfig sets esModuleInterop:false, so `import x = require(...)` is the
      // correct form for CommonJS deps (express) — not a lint smell here.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
