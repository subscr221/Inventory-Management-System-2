import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { alreadyPersisted } from './indent.js';
import { insertRdPrototype } from '../read/projections/rd_prototype.js';
import { assertProjectCodeActive } from './rd-guards.js';

const BUILD_COMPLETE = 'rd_build.completed';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = 400,
): never {
  throw new AppError(status, code, message, details);
}
export function rdPrototypeEventType(envelope: EventEnvelope): string | null {
  return envelope.stream_type === 'research' && envelope.event_type === BUILD_COMPLETE
    ? BUILD_COMPLETE
    : null;
}
export function assertRdBuildCompletedShape(envelope: EventEnvelope): void {
  if (!rdPrototypeEventType(envelope)) return;
  const p = envelope.payload as Record<string, unknown>;
  for (const f of ['prototype_id', 'build_id', 'location_id'])
    if (typeof p[f] !== 'string' || !UUID.test(p[f] as string))
      reject('INVALID_PARAMS', `${f} must be a UUID`);
  for (const f of ['sku', 'serial_number', 'lot_id'])
    if (typeof p[f] !== 'string' || !(p[f] as string).trim())
      reject('INVALID_PARAMS', `${f} is required`);
}
export async function applyRdBuildCompletedProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (!rdPrototypeEventType(envelope) || (await alreadyPersisted(envelope, client))) return;
  const p = envelope.payload as Record<string, unknown>;
  const build = await client.query(
    'SELECT build_id, project_code, outcome, built_quantity, built_uom FROM rd_build_record WHERE build_id=$1 FOR UPDATE',
    [p['build_id']],
  );
  if (!build.rows[0])
    reject('BUILD_NOT_FOUND', 'Build record not found', { build_id: p['build_id'] }, 404);
  if (build.rows[0]['outcome'] !== 'success')
    reject(
      'RD_BUILD_NOT_COMPLETED',
      'Only successful builds can be registered as prototypes',
      { build_id: p['build_id'] },
      409,
    );
  const projectCode = build.rows[0]['project_code'] as string | null;
  if (!projectCode)
    reject(
      'PROJECT_CODE_REQUIRED',
      'A project code is required to register a prototype',
      { build_id: p['build_id'] },
      409,
    );
  const project = await client.query('SELECT status FROM rd_project WHERE project_code = $1', [
    projectCode,
  ]);
  assertProjectCodeActive(projectCode, (project.rows[0] as { status: string } | undefined) ?? null);
  const lot = await client.query(
    'SELECT lot_id,lot_number,sku FROM lot_master WHERE lot_id::text=$1 OR lot_number=$1 LIMIT 1',
    [p['lot_id']],
  );
  if (!lot.rows[0] || lot.rows[0]['sku'] !== p['sku'])
    reject(
      'LOT_NOT_FOUND',
      'Prototype lot does not match its SKU',
      { lot_id: p['lot_id'], sku: p['sku'] },
      404,
    );
  const location = await client.query(
    'SELECT location_code FROM location_register WHERE location_id=$1',
    [p['location_id']],
  );
  if (!location.rows[0])
    reject(
      'LOCATION_NOT_FOUND',
      'Prototype location not found',
      { location_id: p['location_id'] },
      404,
    );
  try {
    await insertRdPrototype(
      {
        prototype_id: p['prototype_id'] as string,
        build_id: p['build_id'] as string,
        project_code: projectCode!,
        sku: p['sku'] as string,
        serial_number: p['serial_number'] as string,
        lot_id: lot.rows[0]['lot_id'] as string,
        location_id: p['location_id'] as string,
        stock_class: 'prototype',
        built_quantity: String(build.rows[0]['built_quantity']),
        uom: build.rows[0]['built_uom'] as string,
        status: 'registered',
        source_event_id: eventId,
      },
      client,
    );
    await client.query(
      'INSERT INTO serial_master (serial_number,sku,lot_id,current_location_id,current_location_code,current_quantity) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        p['serial_number'],
        p['sku'],
        lot.rows[0]['lot_number'],
        p['location_id'],
        location.rows[0]['location_code'],
        build.rows[0]['built_quantity'],
      ],
    );
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: unknown }).code === '23505'
    )
      reject(
        'DUPLICATE_SERIAL',
        'Serial number is already registered for this SKU',
        { sku: p['sku'], serial_number: p['serial_number'] },
        409,
      );
    throw err;
  }
}
export function isNonSaleableClass(stockClass: string): boolean {
  return stockClass === 'prototype';
}
export async function nonSaleablePrototypeBlocked(
  lotIds: string[],
  client: PoolClient,
): Promise<string[]> {
  if (lotIds.length === 0) return [];
  const result = await client.query(
    "SELECT DISTINCT lot_id FROM rd_prototype WHERE lot_id = ANY($1::text[]) AND status = 'registered' ORDER BY lot_id",
    [lotIds],
  );
  return result.rows.map((row: Record<string, unknown>) => row['lot_id'] as string);
}
