import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import noHardcodedRoleInWorkflow from "./eslint-rules/no-hardcoded-role-in-workflow.js";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2024,
        sourceType: "module",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // FR-DOA-01 / AD-3: approval/workflow code must resolve roles through the DOA registry, never
    // branch on a role-name literal. Scoped to application source; the RBAC/auth infrastructure and
    // the read projections legitimately carry role STRINGS as data (on RoleAssignment objects and in
    // resolution queries), not branching LOGIC on a role, so they are excluded.
    files: ["src/**/*.ts"],
    ignores: ["src/middleware/rbac.ts", "src/middleware/auth.ts", "src/read/projections/**"],
    plugins: { doa: { rules: { "no-hardcoded-role-in-workflow": noHardcodedRoleInWorkflow } } },
    rules: { "doa/no-hardcoded-role-in-workflow": "error" },
  },
  {
    ignores: ["dist/", "node_modules/", "deploy/"],
  }
);
