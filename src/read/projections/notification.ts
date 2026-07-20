import type { PoolClient } from 'pg';
import { getPool } from '../../config/db.js';

export type NotificationStatus = 'created' | 'read' | 'acted_upon' | 'expired';
export type DeliveryChannel = 'in_app' | 'web_push';
export type DeliveryOutcome = 'delivered' | 'failed';

export interface NotificationRecord {
  notification_id: string;
  source_event_id: string;
  target_user_id: string;
  target_role: string;
  target_location_id: string | null;
  event_type: string;
  status_verb: string;
  object_type: string;
  object_id: string;
  actor_label: string | null;
  next_step: string | null;
  status: NotificationStatus;
  occurred_at: string;
  read_at: string | null;
  acted_upon_at: string | null;
  expired_at: string | null;
  created_at: string;
}

export interface InsertNotificationInput {
  source_event_id: string;
  target_user_id: string;
  target_role: string;
  target_location_id: string | null;
  event_type: string;
  status_verb: string;
  object_type: string;
  object_id: string;
  actor_label: string | null;
  next_step: string | null;
  occurred_at: string;
}

export interface NotificationDeliveryRecord {
  delivery_id: string;
  notification_id: string;
  channel: DeliveryChannel;
  outcome: DeliveryOutcome;
  trace_id: string;
  failure_reason: string | null;
  delivered_at: string;
}

export interface RecordDeliveryInput {
  notification_id: string;
  channel: DeliveryChannel;
  outcome: DeliveryOutcome;
  trace_id: string;
  failure_reason: string | null;
}

export interface EscalationDefRecord {
  source_event_id: string;
  origin_target_role: string;
  escalation_target_role: string;
  acknowledgment_window_seconds: number;
  deadline_at: string;
  resolved: boolean;
  created_at: string;
}

export interface UpsertEscalationDefInput {
  source_event_id: string;
  origin_target_role: string;
  escalation_target_role: string;
  acknowledgment_window_seconds: number;
  deadline_at: string;
}

export interface RecordEscalationInput {
  source_event_id: string;
  from_target: string;
  to_target: string;
  resolved_via: string;
  escalated_source_event_id: string | null;
}

export interface NotificationListFilters {
  eventType?: string | undefined;
  status?: NotificationStatus | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

type Queryable = Pick<PoolClient, 'query'>;

function runner(client?: PoolClient): Queryable {
  return client ?? getPool();
}

const NOTIFICATION_COLUMNS = `notification_id, source_event_id, target_user_id, target_role, target_location_id, event_type,
   status_verb, object_type, object_id, actor_label, next_step, status, occurred_at, read_at, acted_upon_at, expired_at, created_at`;

function mapNotification(row: Record<string, unknown>): NotificationRecord {
  const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
  const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
  return {
    notification_id: row['notification_id'] as string,
    source_event_id: row['source_event_id'] as string,
    target_user_id: row['target_user_id'] as string,
    target_role: row['target_role'] as string,
    target_location_id: (row['target_location_id'] as string | null) ?? null,
    event_type: row['event_type'] as string,
    status_verb: row['status_verb'] as string,
    object_type: row['object_type'] as string,
    object_id: row['object_id'] as string,
    actor_label: (row['actor_label'] as string | null) ?? null,
    next_step: (row['next_step'] as string | null) ?? null,
    status: row['status'] as NotificationStatus,
    occurred_at: iso(row['occurred_at']),
    read_at: isoOrNull(row['read_at']),
    acted_upon_at: isoOrNull(row['acted_upon_at']),
    expired_at: isoOrNull(row['expired_at']),
    created_at: iso(row['created_at']),
  };
}

/**
 * Idempotent fan-out insert: ON CONFLICT (source_event_id, target_user_id) is a no-op, so a
 * dispatcher that reprocesses an already-fanned-out event after a crash never double-notifies
 * the same recipient. Returns the existing row on conflict rather than null, so callers (the
 * dispatcher) always have a notification_id to record deliveries against.
 */
export async function insertNotification(input: InsertNotificationInput, client?: PoolClient): Promise<NotificationRecord> {
  const inserted = await runner(client).query(
    `INSERT INTO notifications (source_event_id, target_user_id, target_role, target_location_id, event_type,
       status_verb, object_type, object_id, actor_label, next_step, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (source_event_id, target_user_id) DO NOTHING
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [
      input.source_event_id,
      input.target_user_id,
      input.target_role,
      input.target_location_id,
      input.event_type,
      input.status_verb,
      input.object_type,
      input.object_id,
      input.actor_label,
      input.next_step,
      input.occurred_at,
    ],
  );
  if (inserted.rows.length > 0) return mapNotification(inserted.rows[0]!);
  const existing = await runner(client).query(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE source_event_id = $1 AND target_user_id = $2`,
    [input.source_event_id, input.target_user_id],
  );
  return mapNotification(existing.rows[0]!);
}

export async function getNotification(notificationId: string, client?: PoolClient): Promise<NotificationRecord | null> {
  const result = await runner(client).query(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE notification_id = $1`, [notificationId]);
  return result.rows.length > 0 ? mapNotification(result.rows[0]!) : null;
}

/**
 * Any one fanned-out recipient row for a source_event_id - every recipient shares the same
 * content fields (status_verb/object_type/object_id/...), only target_user_id differs, so "any
 * one" is sufficient. Used by the escalation clock (src/notify/escalate.ts) to carry the
 * ORIGINAL alert's content into the escalation notification, rather than escalating with no
 * context. Returns null if the alert's role had zero holders at dispatch time (no row was ever
 * fanned out) - the caller falls back to a generic message in that case.
 */
export async function getAnyNotificationBySourceEvent(sourceEventId: string, client?: PoolClient): Promise<NotificationRecord | null> {
  const result = await runner(client).query(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE source_event_id = $1 LIMIT 1`, [sourceEventId]);
  return result.rows.length > 0 ? mapNotification(result.rows[0]!) : null;
}

export async function listNotificationsForUser(
  userId: string,
  filters: NotificationListFilters = {},
  client?: PoolClient,
): Promise<NotificationRecord[]> {
  const conditions: string[] = ['target_user_id = $1'];
  const params: unknown[] = [userId];
  if (filters.eventType) {
    params.push(filters.eventType);
    conditions.push(`event_type = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.since) {
    params.push(filters.since);
    conditions.push(`occurred_at >= $${params.length}`);
  }
  if (filters.until) {
    params.push(filters.until);
    conditions.push(`occurred_at <= $${params.length}`);
  }
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  params.push(limit, offset);
  const result = await runner(client).query(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
     WHERE ${conditions.join(' AND ')}
     ORDER BY occurred_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return result.rows.map(mapNotification);
}

export async function countUnreadForUser(userId: string, client?: PoolClient): Promise<number> {
  const result = await runner(client).query(
    `SELECT count(*)::int AS count FROM notifications WHERE target_user_id = $1 AND status = 'created'`,
    [userId],
  );
  return result.rows[0]!['count'] as number;
}

export async function markNotificationRead(notificationId: string, userId: string, client?: PoolClient): Promise<NotificationRecord | null> {
  const result = await runner(client).query(
    `UPDATE notifications SET status = 'read', read_at = now()
     WHERE notification_id = $1 AND target_user_id = $2 AND status = 'created'
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [notificationId, userId],
  );
  return result.rows.length > 0 ? mapNotification(result.rows[0]!) : null;
}

export async function markNotificationActedUpon(notificationId: string, userId: string, client?: PoolClient): Promise<NotificationRecord | null> {
  const result = await runner(client).query(
    `UPDATE notifications SET status = 'acted_upon', acted_upon_at = now(), read_at = COALESCE(read_at, now())
     WHERE notification_id = $1 AND target_user_id = $2 AND status IN ('created', 'read')
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [notificationId, userId],
  );
  return result.rows.length > 0 ? mapNotification(result.rows[0]!) : null;
}

export async function expireStaleNotifications(olderThanDays: number, client?: PoolClient): Promise<number> {
  const result = await runner(client).query(
    `UPDATE notifications SET status = 'expired', expired_at = now()
     WHERE status IN ('created', 'read') AND created_at < now() - ($1 || ' days')::interval`,
    [olderThanDays],
  );
  return result.rowCount ?? 0;
}

export async function recordDelivery(input: RecordDeliveryInput, client?: PoolClient): Promise<NotificationDeliveryRecord> {
  const result = await runner(client).query(
    `INSERT INTO notification_deliveries (notification_id, channel, outcome, trace_id, failure_reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING delivery_id, notification_id, channel, outcome, trace_id, failure_reason, delivered_at`,
    [input.notification_id, input.channel, input.outcome, input.trace_id, input.failure_reason],
  );
  const row = result.rows[0]!;
  return {
    delivery_id: row['delivery_id'] as string,
    notification_id: row['notification_id'] as string,
    channel: row['channel'] as DeliveryChannel,
    outcome: row['outcome'] as DeliveryOutcome,
    trace_id: row['trace_id'] as string,
    failure_reason: (row['failure_reason'] as string | null) ?? null,
    delivered_at: row['delivered_at'] instanceof Date ? (row['delivered_at'] as Date).toISOString() : String(row['delivered_at']),
  };
}

export async function isEventDispatched(sourceEventId: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(`SELECT 1 FROM notification_dispatch_log WHERE source_event_id = $1`, [sourceEventId]);
  return result.rows.length > 0;
}

export async function markEventDispatched(sourceEventId: string, client?: PoolClient): Promise<void> {
  await runner(client).query(
    `INSERT INTO notification_dispatch_log (source_event_id) VALUES ($1) ON CONFLICT (source_event_id) DO NOTHING`,
    [sourceEventId],
  );
}

function mapEscalationDef(row: Record<string, unknown>): EscalationDefRecord {
  return {
    source_event_id: row['source_event_id'] as string,
    origin_target_role: row['origin_target_role'] as string,
    escalation_target_role: row['escalation_target_role'] as string,
    acknowledgment_window_seconds: row['acknowledgment_window_seconds'] as number,
    deadline_at: row['deadline_at'] instanceof Date ? (row['deadline_at'] as Date).toISOString() : String(row['deadline_at']),
    resolved: row['resolved'] as boolean,
    created_at: row['created_at'] instanceof Date ? (row['created_at'] as Date).toISOString() : String(row['created_at']),
  };
}

export async function upsertEscalationDef(input: UpsertEscalationDefInput, client?: PoolClient): Promise<EscalationDefRecord> {
  const result = await runner(client).query(
    `INSERT INTO notification_escalation_defs (source_event_id, origin_target_role, escalation_target_role, acknowledgment_window_seconds, deadline_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_event_id) DO NOTHING
     RETURNING source_event_id, origin_target_role, escalation_target_role, acknowledgment_window_seconds, deadline_at, resolved, created_at`,
    [input.source_event_id, input.origin_target_role, input.escalation_target_role, input.acknowledgment_window_seconds, input.deadline_at],
  );
  if (result.rows.length > 0) return mapEscalationDef(result.rows[0]!);
  const existing = await runner(client).query(
    `SELECT source_event_id, origin_target_role, escalation_target_role, acknowledgment_window_seconds, deadline_at, resolved, created_at
     FROM notification_escalation_defs WHERE source_event_id = $1`,
    [input.source_event_id],
  );
  return mapEscalationDef(existing.rows[0]!);
}

export async function getEscalationDefBySourceEvent(sourceEventId: string, client?: PoolClient): Promise<EscalationDefRecord | null> {
  const result = await runner(client).query(
    `SELECT source_event_id, origin_target_role, escalation_target_role, acknowledgment_window_seconds, deadline_at, resolved, created_at
     FROM notification_escalation_defs WHERE source_event_id = $1`,
    [sourceEventId],
  );
  return result.rows.length > 0 ? mapEscalationDef(result.rows[0]!) : null;
}

/** Marks an escalation definition resolved so the escalation poll loop stops considering it (acknowledged by any recipient, or already escalated). */
export async function resolveEscalationDef(sourceEventId: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(
    `UPDATE notification_escalation_defs SET resolved = true WHERE source_event_id = $1 AND resolved = false`,
    [sourceEventId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function findDueEscalationDefs(now: string, limit = 100, client?: PoolClient): Promise<EscalationDefRecord[]> {
  const result = await runner(client).query(
    `SELECT source_event_id, origin_target_role, escalation_target_role, acknowledgment_window_seconds, deadline_at, resolved, created_at
     FROM notification_escalation_defs
     WHERE resolved = false AND deadline_at <= $1
     ORDER BY deadline_at ASC
     LIMIT $2`,
    [now, limit],
  );
  return result.rows.map(mapEscalationDef);
}

export async function recordEscalation(input: RecordEscalationInput, client?: PoolClient): Promise<void> {
  await runner(client).query(
    `INSERT INTO notification_escalations (source_event_id, from_target, to_target, resolved_via, escalated_source_event_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.source_event_id, input.from_target, input.to_target, input.resolved_via, input.escalated_source_event_id],
  );
}

export interface PushSubscriptionRecord {
  subscription_id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function upsertPushSubscription(
  userId: string,
  endpoint: string,
  p256dh: string,
  auth: string,
  client?: PoolClient,
): Promise<PushSubscriptionRecord> {
  const result = await runner(client).query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
     RETURNING subscription_id, user_id, endpoint, p256dh, auth`,
    [userId, endpoint, p256dh, auth],
  );
  const row = result.rows[0]!;
  return {
    subscription_id: row['subscription_id'] as string,
    user_id: row['user_id'] as string,
    endpoint: row['endpoint'] as string,
    p256dh: row['p256dh'] as string,
    auth: row['auth'] as string,
  };
}

export async function deletePushSubscription(userId: string, endpoint: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
  return (result.rowCount ?? 0) > 0;
}

export async function listPushSubscriptionsForUser(userId: string, client?: PoolClient): Promise<PushSubscriptionRecord[]> {
  const result = await runner(client).query(`SELECT subscription_id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [
    userId,
  ]);
  return result.rows.map((row) => ({
    subscription_id: row['subscription_id'] as string,
    user_id: row['user_id'] as string,
    endpoint: row['endpoint'] as string,
    p256dh: row['p256dh'] as string,
    auth: row['auth'] as string,
  }));
}

export async function isOptedIn(userId: string, eventType: string, client?: PoolClient): Promise<boolean> {
  const result = await runner(client).query(`SELECT opted_in FROM notification_preferences WHERE user_id = $1 AND event_type = $2`, [
    userId,
    eventType,
  ]);
  return result.rows.length > 0 ? (result.rows[0]!['opted_in'] as boolean) : false;
}

export async function setPreference(userId: string, eventType: string, optedIn: boolean, client?: PoolClient): Promise<void> {
  await runner(client).query(
    `INSERT INTO notification_preferences (user_id, event_type, opted_in, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, event_type) DO UPDATE SET opted_in = EXCLUDED.opted_in, updated_at = now()`,
    [userId, eventType, optedIn],
  );
}

export async function listPreferencesForUser(userId: string, client?: PoolClient): Promise<Array<{ event_type: string; opted_in: boolean }>> {
  const result = await runner(client).query(`SELECT event_type, opted_in FROM notification_preferences WHERE user_id = $1`, [userId]);
  return result.rows.map((row) => ({ event_type: row['event_type'] as string, opted_in: row['opted_in'] as boolean }));
}
