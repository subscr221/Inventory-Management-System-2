/**
 * ESLint rule: no-hardcoded-role-in-workflow
 *
 * Enforces FR-DOA-01 / AD-3 ("the DOA registry resolves approvers for every workflow; no approval
 * path can be hard-coded"). It is the observable, CI-runnable pass/fail check that Story 1.4's AC1
 * requires: approval/workflow code must resolve roles through the DOA registry
 * (POST /api/v1/doa/resolve), never branch on a role-name string literal.
 *
 * It is a plain flat-config rule object (no plugin package needed). It flags two structural
 * patterns rather than maintaining a list of "known role names" (which would have to stay in sync
 * with runtime registry data - an unfixable staleness problem):
 *   (a) a comparison (===, !==, ==, !=) between a role-like operand and a string literal;
 *   (b) a switch whose discriminant is role-like and has any string-literal case.
 * "role-like" = an Identifier named `role`, or a non-computed member expression `.role`.
 */

const MESSAGE =
  'Hard-coded role-name literal in a role comparison; resolve approvers through the DOA registry ' +
  '(POST /api/v1/doa/resolve) instead of hard-coding role names. [FR-DOA-01]';

function isStringLiteral(node) {
  return (
    node &&
    ((node.type === 'Literal' && typeof node.value === 'string') ||
      (node.type === 'TemplateLiteral' && node.expressions.length === 0))
  );
}

function isRoleLike(node) {
  if (!node) return false;
  if (node.type === 'Identifier' && node.name === 'role') return true;
  if (node.type === 'MemberExpression' && !node.computed && node.property && node.property.type === 'Identifier' && node.property.name === 'role') {
    return true;
  }
  return false;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow hard-coded role-name literals in role comparisons; resolve via the DOA registry (FR-DOA-01).',
    },
    schema: [],
    messages: { hardcodedRole: MESSAGE },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        const roleOperandComparedToLiteral =
          (isRoleLike(node.left) && isStringLiteral(node.right)) || (isRoleLike(node.right) && isStringLiteral(node.left));
        if (roleOperandComparedToLiteral) {
          context.report({ node, messageId: 'hardcodedRole' });
        }
      },
      SwitchStatement(node) {
        if (!isRoleLike(node.discriminant)) return;
        for (const c of node.cases) {
          if (c.test && isStringLiteral(c.test)) {
            context.report({ node: c, messageId: 'hardcodedRole' });
          }
        }
      },
    };
  },
};

export default rule;
