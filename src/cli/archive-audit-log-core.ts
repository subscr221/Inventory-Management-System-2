import { mkdirSync, writeFileSync } from 'node:fs';
import type pg from 'pg';
import { auditConfig, retentionCutoff } from '../config/audit.js';

export interface ArchiveRunResult {
  archivedCount: number;
  archivePath: string | null;
}

/**
 * Archives audit-log entries older than the retention window: exports them to a JSON file under
 * archive/ and records one marker per row in audit_log_archive. Rows are NEVER deleted from
 * audit_log - archival is an export/copy inside the retention window, and "already archived" is
 * defined solely by marker presence (audit_log is append-only; an archived flag would be
 * unsettable because every UPDATE is trigger-rejected).
 *
 * Exported separately from the CLI entry point so integration tests can exercise the full
 * selection/export/marker flow against a real database.
 */
export async function runArchiveAuditLog(pool: pg.Pool, now: Date = new Date()): Promise<ArchiveRunResult> {
  const cutoff = retentionCutoff(now, auditConfig.retentionYears);
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT log_id, trace_id, user_id, role, location_id, timestamp, endpoint, method, event_id, http_status, error_code, details
         FROM audit_log l
        WHERE l.created_at < $1
          AND NOT EXISTS (SELECT 1 FROM audit_log_archive a WHERE a.original_log_id = l.log_id)
        ORDER BY l.created_at ASC`,
      [cutoff.toISOString()],
    );

    if (result.rows.length === 0) {
      return { archivedCount: 0, archivePath: null };
    }

    // Ensure the archive/ directory exists before writing (the export target is created lazily).
    mkdirSync('archive', { recursive: true });

    const archivePath = `archive/audit-log-${now.toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(archivePath, JSON.stringify(result.rows, null, 2), 'utf-8');

    // One transaction for the whole marker batch, and ON CONFLICT DO NOTHING against the unique
    // original_log_id index so a concurrent or re-run execution cannot double-mark a row (the
    // NOT EXISTS pre-check cannot see another run's uncommitted markers).
    await client.query('BEGIN');
    let inserted = 0;
    for (const row of result.rows) {
      const res = await client.query(
        `INSERT INTO audit_log_archive (original_log_id, archive_path) VALUES ($1, $2)
         ON CONFLICT (original_log_id) DO NOTHING`,
        [row['log_id'], archivePath],
      );
      inserted += res.rowCount ?? 0;
    }
    await client.query('COMMIT');

    return { archivedCount: inserted, archivePath };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
