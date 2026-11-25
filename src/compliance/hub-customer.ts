import type { PoolClient } from 'pg';
import type { EventEnvelope } from '../events/store.js';
import { AppError } from '../middleware/error.js';
import { alreadyPersisted } from './indent.js';
import { getHubCustomerById } from '../read/projections/hub.js';
import type { HubCustomerRow } from '../read/projections/hub.js';

/**
 * Story 10.4 (FR-RD-13): hub member and walk-in customer register, plus the single-customer
 * reference guard that every hub transaction (booking here, sale in 10.6, job card in 10.7) calls.
 */
const CUSTOMER_REGISTERED = 'hub.customer_registered';
export const HUB_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hubReject(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = 400,
): never {
  throw new AppError(status, code, message, details);
}

/** P6: a hub location must exist and be a maker_hub_store (shared by customer and machine apply). */
export async function requireHubLocation(client: PoolClient, locationId: unknown): Promise<void> {
  const loc = await client.query('SELECT location_type FROM location_register WHERE location_id = $1', [locationId]);
  if (!loc.rows[0]) hubReject('LOCATION_NOT_FOUND', 'Hub location not found', { location_id: locationId }, 404);
  if (loc.rows[0]['location_type'] !== 'maker_hub_store')
    hubReject('INVALID_PARAMS', 'location must be a maker_hub_store', { location_id: locationId });
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function hubCustomerEventType(envelope: EventEnvelope): string | null {
  return envelope.stream_type === 'research' && envelope.event_type === CUSTOMER_REGISTERED
    ? CUSTOMER_REGISTERED
    : null;
}

/**
 * Pure, pre-transaction guard (FR-RD-13): exactly one customer reference. Accepts `customer_id`,
 * `member_id`, `walk_in_id` or a one-element `customer_ids`; zero, or more than one reference of
 * any combination, is MEMBER_REFERENCE_REQUIRED. Returns the single customer id. Do not fork it.
 */
export function assertSingleHubCustomerRef(p: Record<string, unknown>): string {
  const refs: unknown[] = [];
  // P-I: '' or whitespace is a present-but-invalid reference, not an absent one.
  for (const k of ['customer_id', 'member_id', 'walk_in_id'])
    if (p[k] !== undefined && p[k] !== null) refs.push(p[k]);
  const many = p['customer_ids'];
  if (many !== undefined && many !== null) {
    if (Array.isArray(many)) refs.push(...many);
    else refs.push(many, many); // a non-array value is never a valid single reference
  }
  if (refs.length !== 1 || (typeof refs[0] === 'string' && refs[0].trim() === ''))
    hubReject(
      'MEMBER_REFERENCE_REQUIRED',
      'Exactly one member or walk-in customer reference is required',
      { refs_supplied: refs.length },
    );
  const id = refs[0];
  if (typeof id !== 'string' || !HUB_UUID.test(id))
    hubReject('INVALID_PARAMS', 'customer reference must be a UUID', { refs_supplied: 1 });
  return id;
}

/** DB-side check: the referenced customer exists and is active (404 HUB_CUSTOMER_NOT_FOUND). */
export async function requireActiveHubCustomer(
  client: PoolClient,
  customerId: string,
): Promise<HubCustomerRow> {
  const row = await getHubCustomerById(customerId, client);
  if (!row || row.status !== 'active')
    hubReject('HUB_CUSTOMER_NOT_FOUND', 'Hub customer not found or inactive', { customer_id: customerId }, 404);
  return row;
}

export function assertHubCustomerShape(envelope: EventEnvelope): void {
  if (!hubCustomerEventType(envelope)) return;
  const p = envelope.payload as Record<string, unknown>;
  if (typeof p['customer_id'] !== 'string' || !HUB_UUID.test(p['customer_id']))
    hubReject('INVALID_PARAMS', 'customer_id must be a UUID');
  if (p['customer_kind'] !== 'member' && p['customer_kind'] !== 'walk_in')
    hubReject('INVALID_PARAMS', 'customer_kind must be member or walk_in');
  if (!nonEmpty(p['display_name'])) hubReject('INVALID_PARAMS', 'display_name is required');
  if (p['customer_kind'] === 'member' && !nonEmpty(p['membership_no']))
    hubReject('INVALID_PARAMS', 'membership_no is required for a member');
  // P-H: a blank membership_no on a walk-in is absent (null), not an error.
  if (p['customer_kind'] === 'walk_in' && p['membership_no'] != null && !(typeof p['membership_no'] === 'string' && p['membership_no'].trim() === ''))
    hubReject('INVALID_PARAMS', 'a walk-in customer has no membership_no');
  // X5: no phone capture in Phase 1 (deferred until a privacy decision); never let one into an event.
  for (const k of ['contact_phone', 'contact_phone_hash'])
    if (p[k] !== undefined) hubReject('INVALID_PARAMS', `${k} is not supported`);
  if (p['location_id'] != null && !HUB_UUID.test(String(p['location_id'])))
    hubReject('INVALID_PARAMS', 'location_id must be a UUID');
}

export async function applyHubCustomerProjection(
  envelope: EventEnvelope,
  client: PoolClient,
  eventId: string,
): Promise<void> {
  if (!hubCustomerEventType(envelope) || (await alreadyPersisted(envelope, client))) return;
  const p = envelope.payload as Record<string, unknown>;
  const member = p['customer_kind'] === 'member';
  if (p['location_id'] != null) await requireHubLocation(client, p['location_id']);
  try {
    await client.query(
      `INSERT INTO hub_customer (customer_id, customer_kind, display_name, membership_no, location_id, source_event_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        p['customer_id'],
        p['customer_kind'],
        (p['display_name'] as string).trim(),
        member ? (p['membership_no'] as string).trim() : null,
        p['location_id'] ?? null,
        eventId,
      ],
    );
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code === '23505')
      hubReject('HUB_DUPLICATE_RECORD', 'A hub customer with this id or membership_no exists', { membership_no: p['membership_no'] ?? null }, 409);
    throw err;
  }
}
