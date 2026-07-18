// Preserve the operator's original spelling for error messages, but compare case-insensitively so
// "True"/"TRUE"/"FALSE" are accepted rather than crashing the process at startup.
const enabledRaw = process.env['AUDIT_LOG_ENABLED'] ?? 'true';
const enabledNormalized = enabledRaw.toLowerCase();
const retentionRaw = process.env['AUDIT_LOG_RETENTION_YEARS'] ?? '8';

if (enabledNormalized !== 'true' && enabledNormalized !== 'false') {
  throw new Error(`Invalid AUDIT_LOG_ENABLED "${enabledRaw}": must be "true" or "false"`);
}

const retentionYears = Number(retentionRaw);
if (!Number.isInteger(retentionYears) || retentionYears <= 0) {
  throw new Error(
    `Invalid AUDIT_LOG_RETENTION_YEARS "${retentionRaw}": must be a positive integer`,
  );
}

// Startup-immutable enforcement (Story 1.3, Decision 2 - "A + defense-in-depth guard"): the audit
// log cannot be turned off on a running system. If it is configured off, the process refuses to
// start rather than serving requests without an active audit trail - matching the Companies
// (Accounts) Rules requirement that the audit trail not be capable of being disabled.
if (enabledNormalized === 'false') {
  throw new Error(
    'AUDIT_LOG_DISABLED_AT_STARTUP: The audit log is disabled. No mutating operations are permitted while the audit log is inactive. Set AUDIT_LOG_ENABLED=true to start.',
  );
}

// `enabled` is typed as a plain boolean (not `true as const`) on purpose: after the fail-fast above
// it is always true at runtime, but the wider type keeps the per-request guard in the write path a
// live defense-in-depth check (belt and suspenders) rather than statically-unreachable dead code.
export const auditConfig: { enabled: boolean; retentionYears: number } = {
  enabled: enabledNormalized === 'true',
  retentionYears,
};

/**
 * Computes the archival cutoff: entries with created_at strictly BEFORE the returned instant have
 * aged past the retention window and are eligible for archival export. Entries created exactly
 * `years` ago (to the millisecond) are NOT yet eligible (strict `<` comparison in the CLI query).
 * NOTE: calendar-year subtraction, not financial-year boundaries - the FY start date is an open
 * spec question (see the story's Open Questions; tracked in deferred-work.md).
 */
export function retentionCutoff(now: Date, years: number): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setFullYear(cutoff.getFullYear() - years);
  return cutoff;
}
