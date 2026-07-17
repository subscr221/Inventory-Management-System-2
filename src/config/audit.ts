const enabled = process.env['AUDIT_LOG_ENABLED'] ?? 'true';
const retentionRaw = process.env['AUDIT_LOG_RETENTION_YEARS'] ?? '8';

if (enabled !== 'true' && enabled !== 'false') {
  throw new Error(`Invalid AUDIT_LOG_ENABLED "${enabled}": must be "true" or "false"`);
}

const retentionYears = Number(retentionRaw);
if (!Number.isInteger(retentionYears) || retentionYears <= 0) {
  throw new Error(
    `Invalid AUDIT_LOG_RETENTION_YEARS "${retentionRaw}": must be a positive integer`,
  );
}

if (enabled === 'false') {
  throw new Error(
    'AUDIT_LOG_DISABLED_AT_STARTUP: The audit log is disabled. No mutating operations are permitted while the audit log is inactive. Set AUDIT_LOG_ENABLED=true to start.',
  );
}

export const auditConfig = {
  enabled: true as const,
  retentionYears,
} as const;