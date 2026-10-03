import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Ilhas React compiladas (geradas por `pnpm islands:build`).
    "public/islands/**",
  ]),
  // Ilhas React (islands/**): mesmas regras de React do projeto (acima) e
  // nada de HTML cru — texto da API sempre como texto.
  {
    files: ["islands/**/*.{ts,tsx}"],
    rules: {
      "react/no-danger": "error",
    },
  },
]);

export default eslintConfig;

