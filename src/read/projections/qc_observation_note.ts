import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

/**
 * Story 8.10 (AC 3, D11): the append-only free-text observation note on a QC inspection task.
 * One row per qc.observation_note_recorded event. The optional attachment_id names a photo the
 * caller uploaded (an unclaimed id is allowed for the Story 1.8 offline upload pattern; another
 * user's claimed id is refused by the route).
 */
export interface QcObservationNoteRow {
  note_id: string;
  task_id: string;
  lot_id: string;
  note: string;
  attachment_id: string | null;
  recorded_by: string;
  recorded_at: string;
  source_event_id: string;
  created_at: string;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOTE_COLUMNS = `note_id, task_id, lot_id, note, attachment_id, recorded_by, recorded_at,
    source_event_id, created_at`;

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function mapRow(row: Record<string, unknown>): QcObservationNoteRow {
  return {
    note_id: row['note_id'] as string,
    task_id: row['task_id'] as string,
    lot_id: row['lot_id'] as string,
    note: row['note'] as string,
    attachment_id: (row['attachment_id'] as string | null) ?? null,
    recorded_by: row['recorded_by'] as string,
    recorded_at: toIso(row['recorded_at']),
    source_event_id: row['source_event_id'] as string,
    created_at: toIso(row['created_at']),
  };
}

export async function insertQcObservationNote(
  row: Omit<QcObservationNoteRow, 'created_at'>,
  client: PoolClient,
): Promise<void> {
  await client.query(
    `INSERT INTO qc_observation_note (note_id, task_id, lot_id, note, attachment_id, recorded_by,
       recorded_at, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (note_id) DO NOTHING`,
    [
      row.note_id,
      row.task_id,
      row.lot_id,
      row.note,
      row.attachment_id,
      row.recorded_by,
      row.recorded_at,
      row.source_event_id,
    ],
  );
}

export async function listQcObservationNotes(
  taskId: string,
  client?: PoolClient,
): Promise<QcObservationNoteRow[]> {
  if (!UUID_REGEX.test(taskId)) return [];
  const result = await runner(client).query(
    `SELECT ${NOTE_COLUMNS} FROM qc_observation_note
      WHERE task_id = $1 ORDER BY recorded_at ASC, note_id ASC`,
    [taskId],
  );
  return result.rows.map(mapRow);
}
