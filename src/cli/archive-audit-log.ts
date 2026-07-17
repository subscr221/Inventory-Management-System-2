import { getPool } from '../config/db.js';
import { auditConfig } from '../config/audit.js';

async function archiveAuditLog(): Promise<void> {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - auditConfig.retentionYears);

  const pool = getPool();
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT log_id, trace_id, user_id, role, location_id, timestamp, endpoint, method, event_id, http_status, error_code, details
       FROM audit_log
       WHERE created_at < $1 AND archived = false
       ORDER BY created_at ASC`,
      [cutoff.toISOString()],
    );

    if (result.rows.length === 0) {
      console.log('No audit log entries to archive.');
      return;
    }

    const archivePath = `archive/audit-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(archivePath, JSON.stringify(result.rows, null, 2), 'utf-8');

    for (const row of result.rows) {
      await client.query(
        `INSERT INTO audit_log_archive (original_log_id, archive_path) VALUES ($1, $2)`,
        [row['log_id'], archivePath],
      );
      await client.query(
        `UPDATE audit_log SET archived = true WHERE log_id = $1`,
        [row['log_id']],
      );
    }

    console.log(`Archived ${result.rows.length} audit log entries to ${archivePath}`);
  } catch (err) {
    console.error('Archive failed:', err);
    process.exit(1);
  } finally {
    client.release();
  }
}

archiveAuditLog();