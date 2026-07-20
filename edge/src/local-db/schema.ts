import { column, Schema, Table } from '@powersync/web';

export const edgeOutbox = new Table(
  {
    stream_type: column.text,
    stream_id: column.text,
    event_type: column.text,
    event_version: column.integer,
    payload: column.text,
    metadata: column.text,
    schema_version: column.integer,
    idempotency_key: column.text,
    local_status: column.text,
    server_error_code: column.text,
    server_error_details: column.text,
    created_at: column.text,
    updated_at: column.text,
  },
  { indexes: { status: ['local_status'], idempotency: ['idempotency_key'] } },
);

export const cachedUserContext = new Table(
  {
    user_id: column.text,
    user_name: column.text,
    role: column.text,
    updated_at: column.text,
  },
  { localOnly: true },
);

export const cachedSiteContext = new Table(
  {
    site_id: column.text,
    site_name: column.text,
    updated_at: column.text,
  },
  { localOnly: true },
);

export const syncFailures = new Table(
  {
    event_id: column.text,
    server_error_code: column.text,
    server_error_details: column.text,
    failed_at: column.text,
  },
  { localOnly: true },
);

export const EdgeSchema = new Schema({
  edge_outbox: edgeOutbox,
  cached_user_context: cachedUserContext,
  cached_site_context: cachedSiteContext,
  sync_failures: syncFailures,
});

export type EdgeLocalStatus =
  'pending_sync' | 'syncing' | 'synced' | 'needs_attention' | 'auth_required';
