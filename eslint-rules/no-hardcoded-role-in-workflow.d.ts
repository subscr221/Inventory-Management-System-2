import type { Rule } from 'eslint';

// Type declaration for the plain-JS flat-config rule so TypeScript consumers (the RuleTester unit
// test) get a typed default import instead of an implicit `any`.
declare const rule: Rule.RuleModule;
export default rule;
