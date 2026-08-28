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

// Story 5.5 (AC 4): Released-BOM explosion inputs, replicated DOWN from the central plane through
// the global released_bom_structure bucket in sync/sync-rules.yaml for offline continuity
// (FR-B-07). These are synced (NOT localOnly) reference tables: the edge never writes them, there
// is no capture screen and no outbox path. Table names and column lists must match the bucket's
// data queries exactly. Numerics arrive as text so exact decimal strings survive the round trip -
// SQLite REAL would silently turn them into floats.
export const bom = new Table(
  {
    bom_id: column.text,
    parent_item_id: column.text,
    parent_sku: column.text,
    parent_uom: column.text,
    business_stream: column.text,
    bom_type: column.text,
    status: column.text,
    current_revision_id: column.text,
    updated_at: column.text,
  },
  { indexes: { parent_item: ['parent_item_id'] } },
);

export const bomRevision = new Table(
  {
    revision_id: column.text,
    bom_id: column.text,
    revision_code: column.text,
    revision_status: column.text,
    released_at: column.text,
    released_by: column.text,
  },
  { indexes: { bom: ['bom_id'] } },
);

export const bomLine = new Table(
  {
    bom_line_id: column.text,
    revision_id: column.text,
    bom_id: column.text,
    line_no: column.integer,
    component_item_id: column.text,
    component_sku: column.text,
    output_class: column.text,
    quantity_per: column.text,
    line_uom: column.text,
    uom_conversion_factor: column.text,
    base_quantity_per: column.text,
    scrap_percent: column.text,
    is_phantom: column.integer,
    phantom_source_bom_id: column.text,
    supply_method: column.text,
    effective_from: column.text,
    effective_to: column.text,
    is_released_structure: column.integer,
  },
  { indexes: { revision: ['revision_id'], bom: ['bom_id'] } },
);

export const bomAlternate = new Table(
  {
    bom_alternate_id: column.text,
    bom_id: column.text,
    revision_id: column.text,
    bom_line_id: column.text,
    line_no: column.integer,
    component_item_id: column.text,
    alternate_item_id: column.text,
    alternate_sku: column.text,
    priority: column.integer,
    effective_from: column.text,
    effective_to: column.text,
    origin: column.text,
    is_released_structure: column.integer,
  },
  { indexes: { line: ['bom_line_id'], bom: ['bom_id'] } },
);

// Story 7.8 (FR-M-17, Binding Decision 11): the technician's offline working set, fetched from
// GET /api/v1/edge/maintenance/worklist and cached here. These are localOnly tables (device-private
// cache, the cached_user_context precedent): NO PowerSync sync rule, bucket or publication carries
// them, because work orders and the asset register are company-wide (AD-9) and a location-bucketed
// rule cannot express the worklist. local_head_version is the device's per-stream version cursor
// (seeded from the server stream_version, bumped by nextStreamVersion on every capture against the
// stream, never lowered by a refresh while the stream has unsettled outbox rows). JSON columns
// (recent_closures, meters) are text so the shape survives SQLite verbatim.
export const cachedWorkOrder = new Table(
  {
    work_order_id: column.text,
    asset_id: column.text,
    asset_tag: column.text,
    asset_name: column.text,
    origin: column.text,
    status: column.text,
    priority: column.text,
    due_date: column.text,
    warranty_flagged: column.integer,
    stream_version: column.integer,
    local_head_version: column.integer,
    recent_closures: column.text,
    meters: column.text,
    fetched_at: column.text,
  },
  { localOnly: true },
);

export const cachedSpareReservation = new Table(
  {
    reservation_id: column.text,
    work_order_id: column.text,
    sku: column.text,
    quantity: column.text,
    location_id: column.text,
    stream_version: column.integer,
    local_head_version: column.integer,
    fetched_at: column.text,
  },
  { localOnly: true, indexes: { work_order: ['work_order_id'] } },
);

export const cachedClosureCode = new Table(
  {
    kind: column.text,
    code: column.text,
    fetched_at: column.text,
  },
  { localOnly: true },
);

export const EdgeSchema = new Schema({
  edge_outbox: edgeOutbox,
  cached_user_context: cachedUserContext,
  cached_site_context: cachedSiteContext,
  sync_failures: syncFailures,
  bom,
  bom_revision: bomRevision,
  bom_line: bomLine,
  bom_alternate: bomAlternate,
  cached_work_order: cachedWorkOrder,
  cached_spare_reservation: cachedSpareReservation,
  cached_closure_code: cachedClosureCode,
});

export type EdgeLocalStatus =
  'pending_sync' | 'syncing' | 'synced' | 'needs_attention' | 'auth_required';
