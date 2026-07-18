import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import rule from '../../eslint-rules/no-hardcoded-role-in-workflow.js';

// RuleTester throws on the first failing case, so a single it() that constructs and runs it is
// enough to assert the rule's behavior under `node --test` (matching the repo's test runner).
describe('no-hardcoded-role-in-workflow ESLint rule (FR-DOA-01)', () => {
  it('flags hard-coded role comparisons and allows registry-resolved / non-role code', () => {
    const ruleTester = new RuleTester({
      languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    });

    ruleTester.run('no-hardcoded-role-in-workflow', rule, {
      valid: [
        // A variable that is not literally `role`/`.role` compared to a string is allowed - the rule
        // targets the specific role-branching pattern, not every string comparison.
        { code: `if (transactionType === 'po_approval') { doThing(); }` },
        // Resolving through the DOA registry instead of branching on a role name is the sanctioned path.
        { code: `const approver = await resolveDoa({ transaction_type: 'po_approval', value: 600000 });` },
        // Carrying a role as data (assignment, comparison of non-role fields) is fine.
        { code: `const r = { role: 'procurement_head', module: 'compliance' }; if (r.module === 'compliance') {}` },
        // typeof guard on a variable named role is not a role-name branch.
        { code: `function f(role) { if (typeof role !== 'string') throw new Error('bad'); }` },
        // switch on something other than a role.
        { code: `switch (module) { case 'compliance': break; }` },
      ],
      invalid: [
        {
          code: `if (role === 'procurement_head') { approve(); }`,
          errors: [{ messageId: 'hardcodedRole' }],
        },
        {
          code: `if (user.role !== 'system_administrator') { deny(); }`,
          errors: [{ messageId: 'hardcodedRole' }],
        },
        {
          code: `switch (user.role) { case 'system_administrator': grant(); break; default: deny(); }`,
          errors: [{ messageId: 'hardcodedRole' }],
        },
        {
          // literal on the left side is caught too.
          code: `const ok = 'procurement_head' === role;`,
          errors: [{ messageId: 'hardcodedRole' }],
        },
      ],
    });
  });
});
