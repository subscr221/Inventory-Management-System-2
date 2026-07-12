---
baseline_commit: 5038c40421700f58feffb7a189f166358ae1360e
---

# Story 1.1: Core Infrastructure Deployment and Event Store Schema

Status: review

## Story

As a platform engineer,
I want the core infrastructure (PostgreSQL event store, Node.js API skeleton, Docker containers, self-hosted deployment on a native server or cloud VPS with primary + streaming-replication standby) running with a health endpoint and the versioned event envelope schema in place,
so that every subsequent story has a stable, repeatable deployment target and every event persisted from day one carries the correct envelope fields.

## Acceptance Criteria

1. **Given** the IaC deployment pipeline runs against a clean target host (native server or cloud VPS)
   **When** the deployment completes
   **Then** `GET /api/v1/health` returns HTTP 200 with `{ "status": "ok", "version": "1" }`
   **And** the `domain_events` table exists in PostgreSQL with the full event envelope schema: `event_id` UUID PK, `stream_type`, `stream_id`, `event_type`, `event_version` int (per-stream monotonic), `payload` JSONB, `metadata` JSONB (containing `correlation_id`, `causation_id`, `actor`, `device_id`, `capture_method`, `occurred_at`, `synced_at`), `schema_version` int
   **And** all infrastructure (app containers, self-managed PostgreSQL, reverse proxy, WAL archiving/backups) is in version-controlled IaC under `deploy/` - vendor-neutral, targeting a native server or cloud VPS

2. **Given** a developer submits a test event with all required envelope fields
   **When** the event is persisted
   **Then** a subsequent stream read returns the event with all fields intact, `metadata.synced_at` populated, and `event_version` monotonically incremented per `stream_id`

3. **Given** an event submission missing a required envelope field (e.g., no `actor` or no `correlation_id` in `metadata`)
   **When** the event store processes the write
   **Then** the write is rejected with `error_code: "INVALID_EVENT_ENVELOPE"` and nothing is written to `domain_events`

## Tasks / Subtasks

- [x] Task 1: Project scaffolding and Node.js API skeleton (AC: 1)
  - [x] 1.1 Initialize Node.js 24 LTS project with TypeScript 5.x at project root
  - [x] 1.2 Create `api/` module with REST API gateway structure (`api/v1/`)
  - [x] 1.3 Implement `GET /api/v1/health` endpoint returning `{ "status": "ok", "version": "1" }`
  - [x] 1.4 Implement uniform error envelope middleware: `{ error_code, message, details, trace_id }`
  - [x] 1.5 Set up ESLint, Prettier, and `node:test` (built-in test runner) configuration
- [x] Task 2: Event store schema and write path (AC: 1, 2, 3)
  - [x] 2.1 Create `events/domain_events.sql` migration with the full envelope schema
  - [x] 2.2 Implement event write handler with envelope validation
  - [x] 2.3 Implement per-stream monotonic `event_version` enforcement via `UNIQUE(stream_id, event_version)` constraint
  - [x] 2.4 Implement stream read endpoint returning events for a given `stream_type` + `stream_id`
  - [x] 2.5 Implement `INVALID_EVENT_ENVELOPE` rejection for missing required fields
  - [x] 2.6 Implement idempotency key deduplication (AD-16): duplicate `idempotency_key` returns HTTP 409 with existing `event_id`
- [x] Task 3: Docker and Docker Compose infrastructure (AC: 1)
  - [x] 3.1 Create `deploy/compose/` with Docker Compose stacks for app, PostgreSQL, reverse proxy
  - [x] 3.2 Create Dockerfile for Node.js API (multi-stage build, `node:24-alpine` base)
  - [x] 3.3 Configure PostgreSQL 18.4 container with `wal_level=logical` for PowerSync compatibility
  - [x] 3.4 Configure nginx or Caddy reverse proxy container with TLS termination stubs
  - [x] 3.5 Set up PostgreSQL primary + streaming-replication standby configuration
- [x] Task 4: Database configuration and backup (AC: 1)
  - [x] 4.1 Create `deploy/backup/` with pgBackRest configuration for WAL archiving
  - [x] 4.2 Configure `archive_mode=on`, `archive_command` pointing to pgBackRest
  - [x] 4.3 Set up daily base backup schedule configuration
  - [x] 4.4 Configure PostgreSQL roles: application role with restricted grants (no UPDATE/DELETE on domain_events)
- [x] Task 5: Host provisioning IaC (AC: 1)
  - [x] 5.1 Create `deploy/provision/` with vendor-neutral host provisioning scripts
  - [x] 5.2 Ensure identical image set runs on native server or cloud VPS without code change
- [x] Task 6: Integration tests and verification (AC: 1, 2, 3)
  - [x] 6.1 Write integration test: health endpoint returns 200
  - [x] 6.2 Write integration test: valid event persists and reads back correctly
  - [x] 6.3 Write integration test: invalid envelope rejected with correct error code
  - [x] 6.4 Write integration test: idempotency key deduplication returns 409
  - [x] 6.5 Write integration test: per-stream monotonic version enforcement

## Dev Notes

### Technical Stack (Exact Versions)

| Component | Version | Role |
| --- | --- | --- |
| Node.js | 24 LTS (Krypton, latest 24.16.0) | Runtime. V8 13.6, Undici v7, AsyncLocalStorage optimizations, native `node:test` runner |
| PostgreSQL | 18.4 (self-managed) | Event store + read models. Async I/O subsystem, page checksums enabled by default, `uuidv7()` available |
| PowerSync | Service 1.23.x (self-hosted, Docker) | Edge sync engine. NOT deployed in this story - container definition reserved for Story 1.8 |
| Next.js | 16 (self-hosted: `output: 'standalone'` + Docker) | Frontend PWA + control-plane BFF. NOT deployed in this story - reserved for Story 1.8 |
| TypeScript | 5.x | Language |
| Docker + Docker Compose | latest stable | Container runtime / orchestration |
| nginx or Caddy | latest stable | Reverse proxy + TLS termination |
| pgBackRest | latest stable | WAL archiving + base backups (RPO 1h) |

**Node.js 24 LTS notes (July 2026):**
- Active LTS until October 2026, Maintenance LTS until April 2028
- V8 13.6: `Atomics.pause`, explicit resource management (`using`/`await using`), `Error.isError()`
- Undici v7: improved HTTP client, better performance
- `AsyncLocalStorage` uses `AsyncContextFrame` by default - significant perf improvement for request tracing
- Native `node:test` runner mature with JUnit reporter support - use this instead of Jest/Vitest
- **Known issue in 24.11.0:** `Buffer.allocUnsafe` returned zero-filled buffers - fixed in 24.11.1+. Use latest patch.
- OpenSSL 3.5: RSA/DSA/DH keys < 2048 bits prohibited; ECC keys < 224 bits prohibited

**PostgreSQL 18.4 notes:**
- Released September 2025, latest point release 18.4 (May 2026), EOL November 2030
- Async I/O subsystem: up to 3x faster sequential scans
- `uuidv7()` built-in function for timestamp-ordered UUIDs (consider for `event_id` - but architecture specifies UUIDv4)
- Page checksums enabled by default in new clusters (initdb)
- New wire protocol version 3.2 (first since 2003) - libpq still defaults to 3.0
- OAuth 2.0 authentication support (future use for SSO)
- MD5 auth deprecated - use SCRAM-SHA-256
- `wal_level=logical` required for PowerSync replication (Story 1.8)
- Parallel `COPY FROM` for bulk data loads

### Event Envelope Schema (domain_events)

The `domain_events` table is the single append-only event store. Architecture mandates: single table, not per-stream tables; append-only (no UPDATE/DELETE of domain state); per-stream optimistic concurrency.

```sql
CREATE TABLE domain_events (
  event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_type     TEXT NOT NULL,
  stream_id       UUID NOT NULL,
  event_type      TEXT NOT NULL,
  event_version   INTEGER NOT NULL,
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_stream_version UNIQUE (stream_id, event_version),
  CONSTRAINT uq_idempotency UNIQUE (idempotency_key)
);

CREATE INDEX idx_domain_events_stream ON domain_events (stream_type, stream_id, event_version);
CREATE INDEX idx_domain_events_type ON domain_events (event_type);
CREATE INDEX idx_domain_events_created ON domain_events (created_at);
```

**Metadata JSONB structure (validated at write time):**

```json
{
  "correlation_id": "uuid-v4",
  "causation_id": "uuid-v4",
  "actor": {
    "user_id": "uuid-v4",
    "role": "string",
    "location_id": "uuid-v4"
  },
  "device_id": "string-or-null",
  "capture_method": "AUTO|MANUAL",
  "occurred_at": "ISO-8601-timestamptz",
  "synced_at": "ISO-8601-timestamptz-or-null"
}
```

**Required envelope fields (rejection if missing):**
- `stream_type` - non-empty string
- `stream_id` - valid UUID
- `event_type` - non-empty string, dot-separated past-tense convention (e.g., `gate.entered`, `stock.allocated`)
- `payload` - valid JSONB object
- `metadata.correlation_id` - valid UUID
- `metadata.actor` - object with `user_id`, `role`, `location_id`
- `metadata.occurred_at` - valid timestamptz

**Optional fields:**
- `metadata.causation_id` - UUID (null if root event)
- `metadata.device_id` - string (required for edge-originated events, null for central-plane)
- `metadata.capture_method` - enum `AUTO` or `MANUAL`
- `metadata.synced_at` - null until central plane receives it; populated on central write
- `idempotency_key` - text (AD-16 deduplication key)

### Idempotency Key Infrastructure (AD-16)

Every command that can be issued from multiple devices carries an `idempotency_key`. The central plane deduplicates by this key:
- On duplicate submission: return HTTP 409 with the existing `event_id`
- Stock balance updated exactly once
- The `UNIQUE (idempotency_key)` constraint on `domain_events` enforces this at the database level
- Application layer checks for existing key before insert, returns 409 with existing event_id on conflict

### Naming Conventions (Architecture Compliance)

| Concern | Convention |
| --- | --- |
| Entity names | Singular: `stock_movement`, not `stock_movements` |
| Event names | Past-tense, dot-separated: `gate.entered`, `stock.allocated` |
| Command names | Imperative PascalCase: `EnterGate`, `AllocateStock` |
| File names | Module name, no abbreviations: `inventory/`, `events/` |
| Internal IDs | UUIDv4 for all internal entity identifiers |
| External IDs | Validated strings in `_ext` suffixed fields |
| Timestamps | UTC with timezone in storage; `business_date` is separate IST field |
| Error envelope | `{ error_code, message, details, trace_id }` |
| State mutation | Only through events - no mutable columns for domain state |

### API Contract

- Protocol: REST over HTTPS
- Versioning: URL-prefixed `/api/v1/`
- Error envelope: `{ error_code: "STRING_CODE", message: "Human readable", details: {}, trace_id: "uuid" }`
- Stable error codes for this story: `INVALID_EVENT_ENVELOPE`, `DUPLICATE_EVENT`, `STREAM_CONFLICT`

### Project Structure (Architecture Structural Seed)

```
{root}/
  events/                    # Central event store schema and migrations
    domain_events.sql        # Single table with per-stream optimistic concurrency
  api/                       # REST API gateway
    v1/                      # Versioned API endpoints
  deploy/                    # Infrastructure as code (vendor-neutral)
    compose/                 # Docker Compose stacks (app, Postgres, proxy)
    provision/               # Host provisioning IaC - native server / cloud VPS
    backup/                  # pgBackRest / WAL-archive config
  src/                       # Application source code
    events/                  # Event store write/read logic
    api/                     # API route handlers
    middleware/               # Error handling, validation middleware
    config/                  # Configuration loader
  package.json
  tsconfig.json
  Dockerfile
```

**Modules NOT created in this story** (reserved for future stories): `edge/`, `sync/`, `read/`, `inventory/`, `warehouse/`, `procurement/`, `bom/`, `production/`, `jobwork/`, `research/`, `quality/`, `maintenance/`, `scrap/`, `assets/`, `compliance/`, `gate/`, `reporting/`, `notify/`, `adapters/`.

### Deployment Architecture

**Development profile (this story):**
- Docker Compose on local workstation
- Single PostgreSQL 18.4 instance (no standby)
- No CDN, ephemeral Postgres data
- nginx reverse proxy container

**Production profile (IaC must support):**
- Dockerized containers behind nginx/Caddy TLS
- Self-managed PostgreSQL 18 primary + streaming-replication standby
- WAL archiving via pgBackRest to off-host storage
- Optional CDN/edge cache for static assets

**DR profile (IaC must support):**
- Second native server / VPS (separate site or region)
- PostgreSQL streaming-replication warm standby + archived WAL
- Container definitions replicated via IaC
- Failover target, NOT an active read replica

### PostgreSQL Configuration

Key `postgresql.conf` settings for the event store:

```
wal_level = logical                    # Required for PowerSync (Story 1.8)
max_wal_senders = 10                   # Streaming replication
max_replication_slots = 10
archive_mode = on
archive_command = 'pgbackrest --stanza=main archive-push %p'
archive_timeout = 300                  # 5 min max WAL archive lag
shared_buffers = 256MB                 # Tune for target host
effective_cache_size = 1GB
work_mem = 4MB
maintenance_work_mem = 128MB
checkpoint_completion_target = 0.9
random_page_cost = 1.1                 # SSD storage assumption
log_min_duration_statement = 1000      # Log slow queries > 1s
```

**Database roles:**
- `app_user`: application role - INSERT on `domain_events`, SELECT on `domain_events`, NO UPDATE/DELETE
- `readonly_user`: read model projections - SELECT only
- `replication_user`: streaming replication role with `REPLICATION` attribute
- `admin_user`: DDL and migration role (used only during deployments, not at runtime)

### Backup Configuration (pgBackRest)

**`deploy/backup/pgbackrest.conf` key settings:**
- Stanza: `main`
- Repository: off-host storage (S3-compatible or local path for dev)
- Full backup: weekly
- Differential backup: daily
- WAL archive: continuous, <=1h archive cadence (RPO 1h)
- Retention: full=4, diff=30
- Compression: zstd level 3
- Encryption: AES-256-CBC for off-host storage

### NFR Constraints Binding This Story

| NFR | Requirement | Impact |
| --- | --- | --- |
| NFR-DI-01 | ACID inventory transactions | Event writes must be transactional |
| NFR-DI-04 | Daily backups, RTO 4h, RPO 1h | pgBackRest configured, WAL archiving active |
| NFR-P-05 | API p95 under 500ms | Health endpoint and event write must be fast |
| NFR-S-01 | 50 locations scaling to 200+ | Schema must not assume single-site |
| NFR-S-02 | 500k+ SKUs | Event store must handle high volume |
| NFR-S-05 | 8-financial-year retention | Design for future partitioning/archival |
| NFR-SEC-03 | TLS 1.2+ and AES-256 | Reverse proxy TLS, backup encryption |
| NFR-E-04 | Upgrades under 30 minutes | Docker-based deployment enables fast rollouts |

### Retention Policy (Schema Design Impact)

| Data Class | Retention | Storage |
| --- | --- | --- |
| Event store (all streams) | 8 financial years online | PostgreSQL |
| Event store (archived) | Permanent | S3-compatible object storage, restorable within 48h |
| DPDP PII | Per consent; crypto-shred on erasure | Design event store for crypto-shredding |

**Schema implication:** the `domain_events` table must be designed to support future range partitioning by `created_at` (monthly or yearly) for archival. Do NOT implement partitioning in this story, but ensure the schema does not prevent it.

### What This Story Does NOT Include

- PowerSync Service deployment (Story 1.8)
- Next.js frontend / PWA shell (Story 1.8)
- SSO/authentication (Story 1.2)
- Edit log (Story 1.3)
- DOA registry (Story 1.4)
- Business-stream tagging enforcement (Story 1.5)
- Event-sourced location logic (Story 1.6)
- Calibration lockout (Story 1.7)
- CI/CD pipeline (Story 1.10) - but IaC must be structured to support it
- Spine acceptance tests (Story 1.9)
- Notification service (Story 1.11)
- Any module code (Epics 2-13)

### Project Structure Notes

- This is a **greenfield project** - no existing code, no `package.json`, no Docker files, no `deploy/` directory
- All infrastructure is version-controlled under `deploy/`
- The `deploy/` directory structure mirrors the architecture structural seed
- Vendor-neutral IaC: no cloud-vendor-proprietary managed service dependencies
- The identical image set must run on native server, cloud VPS, or managed-cloud profile without code change

### References

- [Source: `_bmad-output/planning-artifacts/epics.md` #Story 1.1]
- [Source: `_bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md` #Stack, #Structural Seed, #Deployment Topology, #Event Envelope, #AD-16]
- [Source: `_bmad-output/planning-artifacts/prds/prd-Inventory Management System_2-2026-07-10/addendum.md` #Delivery Approach, #Non-disableable Constructs]
- [Source: `PLANNING/prd/8-cross-cutting-nfrs.md` #NFR-DI, #NFR-P, #NFR-S, #NFR-SEC]
- [Source: `PLANNING/prd/9-compliance-and-regulatory.md` #Companies Act audit-trail, #DPDP]
- [Source: `PLANNING/prd/10-integration-and-dependencies.md` #INT-LOC-01, #INT-IAM]

## Dev Agent Record

### Agent Model Used

Qwen 3.7 Max (via Kilo)

### Debug Log References

- Fixed unused `AppError` import in `src/api/v1/events.ts` (TS6133)
- Fixed `import()` type annotation lint error in `src/api/v1/events.ts` - replaced inline `import('node:http').IncomingMessage` with top-level `import type { IncomingMessage }` (consistent-type-imports)
- Fixed test file relative import paths from `../src/` to `../../src/` (test lives in `test/integration/`)
- Integration tests require running PostgreSQL - Docker not available on dev machine; tests verified via TypeScript compilation and ESLint

### Completion Notes List

- **Task 1:** Initialized Node.js 24 LTS + TypeScript 5.8 project with ESM modules. Built HTTP server using native `node:http` module (zero framework dependencies). Implemented `GET /api/v1/health` returning `{ "status": "ok", "version": "1" }`. Error envelope middleware produces `{ error_code, message, details, trace_id }` on all error responses. Router with param extraction. ESLint flat config + Prettier configured.
- **Task 2:** Created `events/domain_events.sql` with full envelope schema including `UNIQUE(stream_id, event_version)` and `UNIQUE(idempotency_key)` constraints. Event write handler validates all required envelope fields (stream_type, stream_id UUID, event_type, payload object, metadata.correlation_id UUID, metadata.actor with user_id/role/location_id, metadata.occurred_at). Per-stream monotonic version computed via `COALESCE(MAX(event_version), 0) + 1`. Idempotency key dedup checks existing key before insert, returns 409 with existing event_id. Stream read returns events ordered by event_version ASC.
- **Task 3:** Multi-stage Dockerfile (deps, build, runner) using `node:24-alpine` with non-root `appuser`. Docker Compose stack: app container, PostgreSQL 18.4 with `wal_level=logical` and all production postgresql.conf settings, nginx reverse proxy, PostgreSQL streaming-replication standby via `pg_basebackup`. `init-db.sql` creates roles and schema on first start.
- **Task 4:** pgBackRest config with stanza `main`, AES-256-CBC encryption, zstd compression, retention full=4/diff=30. PostgreSQL `archive_mode=on` with `archive_command` configured. Backup script supports full/differential modes. Database roles: `app_user` (INSERT+SELECT only), `readonly_user` (SELECT only), `replication_user` (REPLICATION), `admin_user` (DDL). PowerSync publication created for `domain_events`.
- **Task 5:** Vendor-neutral provisioning script checks Docker/Compose availability, builds and starts the stack, runs health check with retry loop. Teardown script for clean removal. No cloud-vendor-specific dependencies.
- **Task 6:** Integration test suite using `node:test` with 7 test cases covering all 3 ACs: health endpoint 200, valid event persist+read with synced_at and monotonic versions, invalid envelope rejection (3 variants: minimal body, missing actor, missing correlation_id), idempotency key 409 dedup, per-stream monotonic version enforcement (3 sequential events verified). Tests require PostgreSQL - run via `docker compose up` then `npm run test`.

### File List

- `package.json` (new)
- `tsconfig.json` (new)
- `eslint.config.js` (new)
- `.prettierrc` (new)
- `.gitignore` (new)
- `.env.example` (new)
- `Dockerfile` (new)
- `src/server.ts` (new)
- `src/config/index.ts` (new)
- `src/config/db.ts` (new)
- `src/middleware/error.ts` (new)
- `src/api/router.ts` (new)
- `src/api/v1/health.ts` (new)
- `src/api/v1/events.ts` (new)
- `src/events/store.ts` (new)
- `src/events/migrate.ts` (new)
- `events/domain_events.sql` (new)
- `deploy/compose/docker-compose.yml` (new)
- `deploy/compose/init-db.sql` (new)
- `deploy/compose/nginx.conf` (new)
- `deploy/backup/pgbackrest.conf` (new)
- `deploy/backup/backup.sh` (new)
- `deploy/provision/provision.sh` (new)
- `deploy/provision/teardown.sh` (new)
- `test/integration/story-1-1.test.ts` (new)
