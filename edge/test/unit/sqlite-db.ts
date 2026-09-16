import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Table } from '@powersync/web';
import type { QueryExecutor } from '../../src/local-db/outbox';
import { EdgeSchema } from '../../src/local-db/schema';

/**
 * Story 1.13: a real SQLite executor for the outbox helpers (Node's built-in node:sqlite), so tests
 * run the helpers' actual SQL instead of a fake that routes on SQL prefixes. Plain tables stand in
 * for PowerSync's views; the columns come from EdgeSchema so the two cannot drift.
 */
export class SqliteDb implements QueryExecutor {
  readonly sqlite = new DatabaseSync(':memory:');
  transactions = 0;
  failOn: string | null = null;

  constructor(tables: string[] = ['edge_outbox', 'edge_outbox_retained', 'cached_user_context', 'cached_site_context']) {
    const schema = EdgeSchema.props as Record<string, Table>;
    for (const name of tables) {
      const columns = schema[name]!.columns.map((column) => `${column.name} TEXT`).join(', ');
      this.sqlite.exec(`CREATE TABLE ${name} (id TEXT PRIMARY KEY, ${columns})`);
    }
  }

  async execute(sql: string, params: unknown[] = []): Promise<unknown> {
    if (this.failOn && sql.includes(this.failOn)) throw new Error(`forced failure: ${this.failOn}`);
    return this.sqlite.prepare(sql).run(...(params as SQLInputValue[]));
  }

  async getAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.sqlite.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  async writeTransaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T> {
    this.transactions += 1;
    this.sqlite.exec('BEGIN');
    try {
      const result = await callback(this);
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  rows(table: string): Array<Record<string, unknown>> {
    return this.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<Record<string, unknown>>;
  }

  /** Stand-in for a PowerSync checkpoint: every synced edge_outbox row is rebuilt from (empty) buckets. */
  checkpoint(): void {
    this.sqlite.exec('DELETE FROM edge_outbox');
  }

  seed(row: { id: string; local_status: string; metadata?: string; server_error_code?: string | null; stream_id?: string; created_at?: string }): void {
    this.sqlite
      .prepare(
        `INSERT INTO edge_outbox (id, stream_type, stream_id, event_type, event_version, payload, metadata,
          schema_version, idempotency_key, local_status, server_error_code, server_error_details, created_at, updated_at)
         VALUES (?, 'maintenance', ?, 'e', 1, '{}', ?, 1, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        row.id,
        row.stream_id ?? 's',
        row.metadata ?? '{}',
        `key-${row.id}`,
        row.local_status,
        row.server_error_code ?? null,
        row.created_at ?? '2026-09-16T00:00:00.000Z',
        row.created_at ?? '2026-09-16T00:00:00.000Z',
      );
  }
}
