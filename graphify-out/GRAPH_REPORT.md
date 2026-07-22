# Graph Report - .  (2026-07-23)

## Corpus Check
- 173 files · ~145,982 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 293 nodes · 281 edges · 83 communities (18 shown, 65 thin omitted)
- Extraction: 87% EXTRACTED · 12% INFERRED · 1% AMBIGUOUS · INFERRED: 35 edges (avg confidence: 0.67)
- Token cost: 769,049 input · 64,394 output

## Community Hubs (Navigation)
- Event Handlers
- Domain Events Audit
- Database Initialization
- Audit Archive
- PRD Planning
- Edge UI App
- API Router Audit
- Inventory Tagging
- Stock Balance
- Deploy Migration
- Location Invariants
- DevOps Compliance
- ERP Integration
- Story 2.8 Tests
- Edge Sync UI
- Story 2.2 Auth
- Story 2.3 Auth
- Story 3.3 Weighbridge
- Deploy Scripts
- Health Rollback
- Environment Config
- Provision Teardown
- Business Streams
- Cycle Count
- Obsolescence Flag
- Inventory Valuation
- Lot Trace
- Retention Tests
- Story 2.4 Auth
- Story 2.5 Auth
- Story 2.6 Count
- Story 2.7 Stock
- Story 3.1 Auth
- Asset Copy
- i18n Locale
- Message Keys
- Locale Resolve
- Cached Site
- Cached User
- Failure Row
- Outbox Counts
- Sync Status
- DOA Registry
- Calibration Status
- ERP Sync State
- Ownership Agreement
- Close Admin Pool
- Close Pool
- Event Envelope
- Authorized Role
- Route Handler
- Upload Failure
- Story 1.11 Tests
- Stock Envelope 2.2
- Stock Envelope 2.3
- Auth Story 2.4
- Stock Envelope 2.4
- Auth Story 2.5
- Create Body 2.5
- Seed Item 2.5
- Seed Serials 2.5
- Seed Stock 2.5
- Auth Story 2.6
- Provision User 2.6
- Auth Story 2.7
- Get Params 2.7
- Provision User 2.7
- Set Params 2.7
- Auth Story 2.8
- Class Entry 2.8
- Provision User 2.8
- Auth Story 2.9
- Make Request 2.9
- PO Batch
- Provision User 2.9
- Auth Story 3.1
- Auth Story 3.2
- Gate Body 3.2
- Make Request 3.2
- Provision User 3.2
- Auth Story 3.3
- Gate Body 3.3
- Provision User 3.3

## God Nodes (most connected - your core abstractions)
1. `PRD Index` - 16 edges
2. `persistEvent` - 13 edges
3. `users table (referenced FK target)` - 13 edges
4. `EdgeClient` - 11 edges
5. `getPool` - 11 edges
6. `createAppRouter` - 11 edges
7. `AppError` - 9 edges
8. `domain_events table` - 9 edges
9. `t` - 8 edges
10. `AppShell` - 8 edges

## Surprising Connections (you probably didn't know these)
- `audit_log table` --conceptually_related_to--> `PRD 9 Compliance and Regulatory`  [INFERRED]
  read/projections/audit_log.sql → PLANNING/prd/9-compliance-and-regulatory.md
- `no-hardcoded-role-in-workflow Rule` --references--> `SCM Requirements Document`  [EXTRACTED]
  eslint-rules/no-hardcoded-role-in-workflow.js → PLANNING/archive/SCM-Requirements-Document.md
- `gate_event table` --conceptually_related_to--> `PRD 4 Features`  [INFERRED]
  read/projections/gate_event.sql → PLANNING/prd/4-features.md
- `location_current / asserted-expected facts` --conceptually_related_to--> `PRD 10 Integration and Dependencies`  [INFERRED]
  read/projections/location.sql → PLANNING/prd/10-integration-and-dependencies.md
- `edge_site_events sync bucket` --references--> `domain_events table`  [EXTRACTED]
  sync/sync-rules.yaml → events/domain_events.sql

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Audit log write flow** — src_api_v1_events_posteventbase, src_events_store_persistevent, src_read_projections_audit_log_logauditentry, read_projections_audit_log_audit_log [EXTRACTED 0.85]
- **Tamper attempt recording** — src_api_v1_config_configauditlogbase, src_middleware_audit_tamper_guard_handletamperattempt, src_read_projections_audit_log_logtamperattempt, read_projections_audit_log_audit_log_tamper_attempt_log [EXTRACTED 0.80]
- **RBAC request pipeline** — src_api_router_router, src_middleware_auth_authenticaterequest, src_middleware_rbac_requirerole, src_middleware_context_getauthcontext [INFERRED 0.75]
- **Permanent Error Code Taxonomy** — edge_src_sync_connector_classifyserveruploadfailure, edge_src_messages_en, edge_test_unit_connector_test [INFERRED 0.80]
- **Offline Capture and Sync Flow** — edge_src_capture_test_capture_createtestcaptureevent, edge_src_local_db_outbox_insertcaptureevent, edge_src_sync_connector_edgepowersyncconnector, edge_src_local_db_schema_edgeoutbox [INFERRED 0.80]
- **CD Pipeline Bootstrap and Verify Flow** — deploy_pipeline_deploy, deploy_pipeline_verify, deploy_pipeline_runner_bootstrap_runner, deploy_pipeline_environments [INFERRED 0.75]
- **Compliance spine read projections** — read_projections_audit_log_audit_log, read_projections_doa_registry_doa_registry_entries, read_projections_business_stream_config_business_streams, read_projections_location_location_current, read_projections_instrument_calibration_instrument_calibration_statuses [INFERRED 0.75]
- **ERP inbound reference projections (Story 2.9)** — read_projections_erp_purchase_order_erp_purchase_order, read_projections_erp_sales_order_erp_sales_order, read_projections_integration_exception_integration_exception [INFERRED 0.70]
- **Frontline edge capture surface** — read_projections_gate_event_gate_event, read_projections_location_location_current, read_projections_location_register_location_register [INFERRED 0.65]
- **Event-sourced read-model projections over domain_events** — read_projections_replenishment_recommendation_replenishment_recommendation, read_projections_serial_master_serial_master, read_projections_stock_balance_stock_balance, read_projections_weighbridge_event_weighbridge_event, events_domain_events_domain_events [INFERRED 0.75]
- **PowerSync edge sync over domain_events** — sync_powersync_config, sync_sync_rules_edge_site_events, sync_migrations_powersync_publication, events_domain_events_domain_events [EXTRACTED 0.80]
- **Integration suites bootstrapping shared users/domain_events schema** — test_integration_story_1_1_suite, test_integration_story_1_2_suite, read_projections_users_users, events_domain_events_domain_events [INFERRED 0.70]
- **Shared Integration Test HTTP Harness** — test_integration_story_2_2_test_makerequest, test_integration_story_2_3_test_makerequest, test_integration_story_2_4_test_makerequest, test_integration_story_2_5_test_makerequest, test_integration_story_2_6_test_makerequest, test_integration_story_2_7_test_makerequest, test_integration_story_2_8_test_makerequest, test_integration_story_2_9_test_makerequest [INFERRED 0.80]
- **Compliance Invariant Guard Functions** — src_compliance_business_stream_assertinventorytagging, src_compliance_calibration_assertcalibrationlockout, src_compliance_location_assertlocationinvariant [INFERRED 0.75]
- **Gate-to-Weighbridge Binding Token Flow** — test_integration_story_3_2_test_gatebody, test_integration_story_3_3_test_newbindingtoken, test_integration_story_3_3_test_wbbody [INFERRED 0.70]
- **Stock-balance seam gating validation flow** — src_compliance_stock_balance_stockBalanceEventKind, src_compliance_stock_balance_assertStockBalanceShape, src_events_store_EventEnvelope [INFERRED 0.70]
- **Sync upload failure classification flow** — src_sync_upload_classifyUploadFailure, src_sync_upload_validateEdgeEnvelope, src_sync_upload_UploadFailureClassification, src_middleware_error_AppError [INFERRED 0.70]

## Communities (83 total, 65 thin omitted)

### Community 0 - "Event Handlers"
Cohesion: 0.11
Nodes (27): Home, createGateEnteredEvent, createTestCaptureEvent, EdgeEventRecord, EdgeClient, createEdgeDatabase, cacheContext, hasAuthRequired (+19 more)

### Community 1 - "Domain Events Audit"
Cohesion: 0.09
Nodes (26): domain_events table, audit_log table, deprovisionUser, provisionUser, updateUserRoles, getStreamBase, runObsolescenceScan, runReplenishmentCheck (+18 more)

### Community 2 - "Database Initialization"
Cohesion: 0.11
Nodes (26): init-db.sql first-boot init, domain_events table, doa_vacation_delegations table, notifications table, replenishment_recommendation table, serial_master table, stock_balance table, transfer_request table (+18 more)

### Community 3 - "Audit Archive"
Cohesion: 0.09
Nodes (23): audit_log_archive table, audit_log_tamper_attempt_log table, configAuditLogBase, postEventBase, archiveAuditLog, auditConfig, getAdminPool, getPool (+15 more)

### Community 4 - "PRD Planning"
Cohesion: 0.13
Nodes (20): SCM Requirements Document, PRD 0 Document Purpose, PRD 10 Integration and Dependencies, PRD 11 Stakeholders and Roles, PRD 12 Data Migration and Cutover, PRD 13 Rollout and Change Management, PRD 14 Open Questions, PRD 15 Assumptions Index (+12 more)

### Community 5 - "Edge UI App"
Cohesion: 0.19
Nodes (15): FirstSyncPage, RootLayout, manifest, SyncErrorPage, Service Worker, AppShell, ServiceWorkerRegistration, SyncFailureList (+7 more)

### Community 6 - "API Router Audit"
Cohesion: 0.20
Nodes (15): Router, auditLogBase, auditLogHandler, configAuditLogHandler, getStreamHandler, postEventHandler, readJsonBody, getParsedBody (+7 more)

### Community 7 - "Inventory Tagging"
Cohesion: 0.24
Nodes (10): assertInventoryTagging, TaggingDeps, assertCalibrationLockout, CalibrationDeps, AppError, TransactionTaggingRule, createAppServer, Story 2.2 Multi-Location Stock Balances Suite (+2 more)

### Community 8 - "Stock Balance"
Cohesion: 0.20
Nodes (10): assertStockBalanceShape, stockBalanceEventKind, EventEnvelope, AppError, classifyUploadFailure, validateEdgeEnvelope, expectInvalidParams, makeEnvelope (+2 more)

### Community 9 - "Deploy Migration"
Cohesion: 0.33
Nodes (7): deploy/compose/init-db.sql, src/events/migrate.ts, extractCreateTable, extractDoBlock, normalizeSql, read, Story 2.1 schema drift guard

### Community 10 - "Location Invariants"
Cohesion: 0.29
Nodes (7): assertLocationInvariant, LocationDeps, PersistedEvent, AssertedLocationFact, CurrentLocation, ExpectedLocationFact, assertLocationInvariant Unit Tests

### Community 11 - "DevOps Compliance"
Cohesion: 0.33
Nodes (6): CI DB Roles SQL, ADR-001 Notification Emission Coupling, no-hardcoded-role-in-workflow Rule, Rule Type Declaration, domain_events Table, no-hardcoded-role-in-workflow Rule Tests

### Community 12 - "ERP Integration"
Cohesion: 0.40
Nodes (5): erp_purchase_order table, erp_sales_order table, in_transit table, integration_exception table, location_register table (topology)

### Community 13 - "Story 2.8 Tests"
Cohesion: 0.50
Nodes (4): getStock (Story 2.8), makeRequest (Story 2.8), postStockEvent (Story 2.8), putAgreement (Story 2.8)

### Community 14 - "Edge Sync UI"
Cohesion: 0.67
Nodes (3): AppShellProps, SyncFailureItem, SyncUiState

### Community 15 - "Story 2.2 Auth"
Cohesion: 0.67
Nodes (3): authFor (Story 2.2), makeRequest (Story 2.2), provisionUser (Story 2.2)

### Community 16 - "Story 2.3 Auth"
Cohesion: 0.67
Nodes (3): authFor (Story 2.3), makeRequest (Story 2.3), provisionUser (Story 2.3)

### Community 17 - "Story 3.3 Weighbridge"
Cohesion: 0.67
Nodes (3): makeRequest (Story 3.3), newBindingToken, wbBody

## Ambiguous Edges - Review These
- `AppError` → `AppError`  [AMBIGUOUS]
  src/middleware/error.ts · relation: references
- `makeEnvelope` → `stockBalanceEventKind`  [AMBIGUOUS]
  test/unit/stock-balance.test.ts · relation: references

## Knowledge Gaps
- **176 isolated node(s):** `RootLayout`, `Home`, `SyncFailureItem`, `MessageKey`, `availableLocales` (+171 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **65 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `AppError` and `AppError`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `makeEnvelope` and `stockBalanceEventKind`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **Why does `audit_log table` connect `Domain Events Audit` to `Database Initialization`, `PRD Planning`, `API Router Audit`?**
  _High betweenness centrality (0.187) - this node is a cross-community bridge._
- **Why does `PRD 9 Compliance and Regulatory` connect `PRD Planning` to `Domain Events Audit`?**
  _High betweenness centrality (0.158) - this node is a cross-community bridge._
- **What connects `RootLayout`, `Home`, `SyncFailureItem` to the rest of the system?**
  _176 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Event Handlers` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._
- **Should `Domain Events Audit` be split into smaller, more focused modules?**
  _Cohesion score 0.08615384615384615 - nodes in this community are weakly interconnected._