# Story 2.10: Item Groups Master

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a stock controller,
I want a governed item group master with each item assigned to a group,
so that grants, reports and rules can target a named group of items instead of free-text categories.

PILOT. Prerequisite of Story 4.8 (grant scope by item group, user ruling 2026-09-29). Epic 2 was reopened for this story and is already `in-progress` in `sprint-status.yaml`. Owner rulings 2026-10-02 (see Dev Notes) narrow who may change groups and add notifications.

## Acceptance Criteria

1. **Create, edit, deactivate, reactivate.** Given a user who holds the `inventory_controller` role AND the matching item group right (D3), when they create a group (`create` right) or change its name or status (`edit` right), then the group has a unique `code` and a name unique ignoring case, the projection row, an `item_group.created` or `item_group.updated` event and an audit row are written in one transaction. Anyone else, including `warehouse_manager`, gets 403 `FUNCTION_ACCESS_DENIED` with `details.required_roles: ['inventory_controller']` or 403 `ITEM_GROUP_RIGHT_REQUIRED` with `details.right`.
2. **Delete only a never-used group.** Given a holder with the `delete` right, when they delete a group that has never had an item assigned, then the row is removed and `item_group.deleted` is written. When any item was ever assigned to it (now or in the past), the delete is refused with 409 `ITEM_GROUP_IN_USE` whose message points to deactivation, and nothing is written. `ON DELETE RESTRICT` stays on the foreign key.
3. **Rights granted only by CEO or Finance Head.** Given a user holding `ceo` or `finance_controller`, when they grant or revoke any combination of `create`, `edit`, `delete` to an `inventory_controller` holder, then the rights are stored, `item_group_right.granted` or `item_group_right.revoked` is written with `before` and `after`, and an audit row records it. A grant to a user without `inventory_controller` is 400 `GRANTEE_NOT_INVENTORY_CONTROLLER`; any other granter is 403 `FUNCTION_ACCESS_DENIED` with `details.required_roles: ['ceo', 'finance_controller']`. Several holders may hold rights at once.
4. **Assign an item.** Given an item, when an `inventory_controller` holder with the `edit` right sets or clears `item_group_id` through `PATCH /api/v1/items/:sku` (or sets it on `POST /api/v1/items`), then the item carries at most one group, the change is the existing audited `item.updated` event with `before` and `after`, and `GET /api/v1/item-groups/:code/items` returns the group's active items. Other item fields keep the existing `inventory` write gate.
5. **Existing items stay valid.** Given items that exist before the deploy, when the story deploys, then every item works with `item_group_id: null`, and `GET /api/v1/item-groups/ungrouped-items` lists the active ungrouped items, ordered by SKU.
6. **Unknown or inactive group refused.** Given a reference to an unknown or inactive group, when an item assignment is saved (or Story 4.8 calls the shared guard, D6), then it is refused with 400 `ITEM_GROUP_NOT_FOUND` or 400 `ITEM_GROUP_INACTIVE` and nothing is written.
7. **Everyone is told.** Given any of: group create, edit, deactivate, reactivate, delete; an item group set, changed or cleared; a rights grant or revoke, when it commits, then exactly one notification per user is emitted in the same transaction to the union of the Table 2 role holders, the users on the item group recipient list, and the actor, with no duplicates. The recipient list is kept by `ceo` or `finance_controller` holders only (403 otherwise), and every change to it is itself audited and notified.
8. **Store controller role exists.** Given the role register and the pilot provisioning path, when this story lands, then `store_controller` (site scope) is registered in the access matrix section 2, is in the pilot role pack with one holder at the pilot site, is provisionable through `staging-provision-roles.sh` and the roles example file, and receives the AC 7 notifications. It gets no other capability in this story (D11).

Source: [epics.md Story 2.10](../planning-artifacts/epics.md), user ruling 2026-09-29 recorded in [Story 4.8](4-8-standing-approvals-and-self-approval-limits.md) (D5, open question 4), owner rulings 2026-10-02.

## Tasks / Subtasks

- [ ] Task 1: Red tests first (AC: 1 to 8)
  - [ ] 1.1 Integration `test/integration/story-2-10.test.ts`. Copy the harness of `test/integration/story-2-1.test.ts` (the `before()` SQL list at lines 149-180, the TRUNCATE, `makeRequest`, persona helpers) and add `read/projections/notification.sql` to the SQL list. TRUNCATE adds `item_group_right`, `item_group_recipient`, `item_group`, and the notification tables listed in `story-1-15.test.ts:189`. Personas: `icFull` (`inventory_controller` with all three rights), `icNone` (`inventory_controller`, no rights), `wm` (`warehouse_manager`, `inventory` write), `ceo`, `fin` (`finance_controller`), `siteHead` (`site_head` at a site), `cfo` (`cfo`), `storeCtl` (`store_controller` at the site), `extra` (plain user, later put on the recipient list).
  - [ ] 1.2 Cases, each with exact values and a negative control:
    - rights (AC 3): `ceo` grants `icFull` `{ create: true, edit: true, delete: true }` and `fin` grants `icNone` `{ create: true }` then revokes it; each writes one `item_group_right.*` event and one audit row. `icFull` granting is 403 `FUNCTION_ACCESS_DENIED`; granting to `wm` is 400 `GRANTEE_NOT_INVENTORY_CONTROLLER`.
    - create (AC 1): `icFull` `POST /api/v1/item-groups { code: 'BEARINGS', name: 'Bearings' }` is 201; `icNone` is 403 `ITEM_GROUP_RIGHT_REQUIRED` with `details.right = 'create'`; `wm` is 403 `FUNCTION_ACCESS_DENIED`. Duplicate code is 409 `DUPLICATE_ITEM_GROUP_CODE`; name `bearings` is 409 `DUPLICATE_ITEM_GROUP_NAME`; code `bearings`, `A`, or 33 characters is 400 `INVALID_PARAMS`.
    - edit (AC 1): rename, deactivate, reactivate each write one `item_group.updated` with `before` and `after`; `{ code }` is 400; empty body is 400; unknown code is 404 `ITEM_GROUP_NOT_FOUND`; a holder with `create` only is 403 `ITEM_GROUP_RIGHT_REQUIRED` (`edit`).
    - delete (AC 2): a fresh group deletes (204, one `item_group.deleted`); a group with an item assigned is 409 `ITEM_GROUP_IN_USE`; a group whose only item was assigned and then cleared is still 409 (D9); a holder without `delete` is 403.
    - assign (AC 4): set, change, clear on `SKU-G1`; `item.updated` carries `item_group_id` in `before` and `after`; `wm` may still PATCH `uom` but gets 403 `FUNCTION_ACCESS_DENIED` when the body carries `item_group_id`.
    - lookup and ungrouped (AC 4, 5): group items returns active items only; ungrouped returns `[SKU-U1, SKU-U2]`, `count: 2`; inactive items absent.
    - refuse (AC 6): random UUID and non-UUID are 400 `ITEM_GROUP_NOT_FOUND`; deactivated group is 400 `ITEM_GROUP_INACTIVE`; item row and `domain_events` count unchanged; `assertItemGroupAssignable` called directly for active, inactive and unknown ids.
    - notify (AC 7): after a create, a `notification.created` event exists per Table 2 role and one with `target.user_id = extra` once `extra` is on the list; after the dispatcher runs, `ceo`, `fin`, `cfo`, `siteHead`, `storeCtl`, `icFull` and `extra` each have a row in `notifications`; `wm` has none. A refused write emits nothing. A user who holds two Table 2 roles and is also on the list gets exactly one notification; the actor gets one. `icFull` adding to the recipient list is 403.
  - [ ] 1.3 Unit, extend `test/unit/schema-drift.test.ts`: new `EXPECTED` entries for `item_group`, `item_group_right`, `item_group_recipient` in `read/projections/item_master.sql`, and assert both SQL copies carry the `item_group_id` column, the `fk_item_master_item_group` block and the `ever_assigned` column (the Story 8.6 test at line 3193 is the pattern).
  - [ ] 1.4 Unit `test/unit/store-controller-role-pack.test.ts` (pattern: `test/unit/site-head-role-pack.test.ts`): the pilot pack has exactly one `store_controller` holder with `location_id: 'site'` on module `warehouse`, read scope; `deploy/provision/roles.example.json` has the same row; `planProvisioning` on the pack returns zero violations and zero errors.
  - [ ] 1.5 Run the files and record the red output in Debug Log References.
- [ ] Task 2: Schema (AC: 1 to 8)
  - [ ] 2.1 `read/projections/item_master.sql`, above `item_master`: `item_group` per D2; `item_group_right (user_id UUID PRIMARY KEY REFERENCES users(user_id), can_create BOOLEAN NOT NULL DEFAULT false, can_edit BOOLEAN NOT NULL DEFAULT false, can_delete BOOLEAN NOT NULL DEFAULT false, granted_by UUID NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`; `item_group_recipient (user_id UUID PRIMARY KEY REFERENCES users(user_id), added_by UUID NOT NULL, added_at TIMESTAMPTZ NOT NULL DEFAULT now())`. Then `item_master.item_group_id UUID`, guarded `fk_item_master_item_group ... ON DELETE RESTRICT`, index `idx_item_master_item_group`.
  - [ ] 2.2 Grants: `item_group` INSERT, SELECT, UPDATE, DELETE (delete is now a feature, guarded in code); `item_group_right` and `item_group_recipient` INSERT, SELECT, UPDATE, DELETE; `readonly_user` SELECT on all three.
  - [ ] 2.3 `deploy/compose/init-db.sql` (item_master section near line 777): duplicate the same content. `users.sql` must run before `item_master.sql` in every harness; it already does in `migrate.ts` and the 2.1 list.
  - [ ] 2.4 No change to `src/events/migrate.ts` (D1).
- [ ] Task 3: Projection modules (AC: 1 to 6)
  - [ ] 3.1 New `src/read/projections/item_group.ts` (shape of `item_master.ts`): `ItemGroup` type, `ITEM_GROUP_CODE_REGEX = /^[A-Z0-9][A-Z0-9_-]{1,31}$/`, `createItemGroup`, `updateItemGroup`, `deleteItemGroupIfNeverUsed(code, client)` (deletes `WHERE ever_assigned = false`, returns the row or null), `markEverAssigned(groupId, client)`, `getItemGroupByCode`, `getItemGroupById`, `listItemGroups`, `listActiveItemsByGroup`, `listUngroupedActiveItems`.
  - [ ] 3.2 Same file: `assertItemGroupAssignable(itemGroupId: unknown, client?)` per D6, read `FOR SHARE` when a client is given.
  - [ ] 3.3 Same file: `getItemGroupRights(userId, client)`, `upsertItemGroupRights(...)`, `listItemGroupRecipients`, `addItemGroupRecipient`, `removeItemGroupRecipient`.
  - [ ] 3.4 `src/read/projections/item_master.ts`: add `item_group_id: string | null` to `ItemMaster`, `CreateItemInput`, `UpdateItemPatch`, `ITEM_COLUMNS`, `mapRow`, the insert and the setter list. Nothing else changes.
- [ ] Task 4: Authority helpers (AC: 1, 3, 4, 7)
  - [ ] 4.1 New `src/compliance/item-group-authority.ts`. `assertHoldsAnyRole(authContext, roles)` checks `authContext.roles.some((r) => roles.includes(r.role))` and throws 403 `FUNCTION_ACCESS_DENIED` with `details.required_roles` (the `assertEdgeDispatchRoleAllowed` shape in `src/api/v1/edge.ts:150-165`, not a new mechanism). `assertItemGroupRight(authContext, right, client)` first requires `inventory_controller`, then reads `item_group_right` and throws 403 `ITEM_GROUP_RIGHT_REQUIRED` with `details.right`.
  - [ ] 4.2 Same file: `notifyItemGroupChange(client, { actor, event_type, status_verb, object_type, object_id, correlation_id })` resolves the active holders of every Table 2 role (any location) plus every recipient-list user plus the actor, de-duplicates them into one set of user ids, and calls `emitNotificationInTransaction` (`src/notify/emit.ts:124`) once per user with `target.user_id` (the Story 4.3 user target, `src/notify/dispatch.ts:181-185`). One notification per user per change, the actor included (ruling round 3).
- [ ] Task 5: Item group API (AC: 1, 2, 3, 5, 7)
  - [ ] 5.1 New `src/api/v1/item-groups.ts`, built like `src/api/v1/items.ts` (BEGIN, authority check, projection write, `persistEvent`, `notifyItemGroupChange`, COMMIT; ROLLBACK on error). Routes and gates in Table 1.
  - [ ] 5.2 Create maps `uq_item_group_code` to 409 `DUPLICATE_ITEM_GROUP_CODE` and `uq_item_group_name_ci` to 409 `DUPLICATE_ITEM_GROUP_NAME`. Update accepts `name` and `status` only. Delete calls `deleteItemGroupIfNeverUsed`; null with an existing row is 409 `ITEM_GROUP_IN_USE` with message `Item group <code> has had items assigned; deactivate it instead`.
  - [ ] 5.3 Rights: `PUT /api/v1/item-groups/rights/:userId` body `{ create, edit, delete }` (booleans, all required); all false is the revoke and removes the row; event `item_group_right.granted` when any right is true afterwards, `item_group_right.revoked` otherwise; payload `{ user_id, before, after }`. `GET /api/v1/item-groups/rights` lists holders.
  - [ ] 5.4 Recipients: `POST /api/v1/item-groups/recipients { user_id }` and `DELETE /api/v1/item-groups/recipients/:userId`; events `item_group_recipient.added` and `item_group_recipient.removed`; unknown or inactive user is 400 `USER_NOT_FOUND`.
  - [ ] 5.5 Events use stream `item_group` with `stream_id` the group id; rights and recipient events use stream `item_group` with `stream_id` the target user id. None is added to `SUPPORTED_EVENT_TYPES` (D7).
  - [ ] 5.6 `src/server.ts` next to lines 571-573: register Table 1 in its order (literal paths before `/:code`, the router takes the first match, `src/api/router.ts:131`).
- [ ] Task 6: Item assignment (AC: 4, 6, 7)
  - [ ] 6.1 `src/api/v1/items.ts`: when the body has the key `item_group_id` (`'item_group_id' in body`), call `assertItemGroupRight(authContext, 'edit', client)` after BEGIN; a string value then goes through `assertItemGroupAssignable` and `markEverAssigned`; `null` clears (PATCH only). The existing `inventory` write gate stays on both routes.
  - [ ] 6.2 When the group value changes, call `notifyItemGroupChange` with `object_type: 'item'`, `object_id` the SKU. Keep `item.created` and `item.updated` unchanged otherwise.
- [ ] Task 7: Access matrix (AC: 1, 3)
  - [ ] 7.1 Load `FORMATTING_RULES.md` before editing any Markdown file.
  - [ ] 7.2 `_bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md` section 3.3: rows "Create item group", "Edit, deactivate or reactivate item group, assign items", "Delete never-used item group" with `C (right)` for `inventory_controller` and `-` for the others including `warehouse_manager`; "Ungrouped items report" `R` for `warehouse_manager` and `inventory_controller`. Section 3.8 or a new 3.11: "Grant or revoke item group rights" and "Maintain item group recipient list" for `ceo` and `finance_controller`.
  - [ ] 7.3 Section 9 changelog row v1.4 naming Story 2.10 and the owner rulings of 2026-10-02.
- [ ] Task 8: Store controller role (AC: 8), following the Story 1.16 `site_head` path
  - [ ] 8.1 `deploy/rehearsal/mock/generate.mjs`: add one `store_controller` grant (`module: 'warehouse'`, `function_scope: 'read'`, `location_id: 'site'`) to the person who holds `warehouse_manager` at the pilot site (confirmed, D11), and actor `storecontroller` in the actors map.
  - [ ] 8.2 `docs/migration/pilot-mock-extract/roles.json` and `world.json`: hand-edit to match, proven by a scratch regeneration (the Story 1.15 and 1.16 method). Grant count rises by one.
  - [ ] 8.3 `deploy/provision/roles.example.json`: one row for `store.controller@example.com`.
  - [ ] 8.4 Do NOT add `store_controller` to `REQUIRED_SITE_ROLES` or to `EXTRA_FORBIDDEN_PAIRS` in this story; that belongs to the follow-up story that defines its duties.
  - [ ] 8.5 Access matrix section 2, "Warehouse and inventory": new row `store_controller` (site scope; "Physical custody of stores and warehouses; in 2.10 receives item group notifications only").
- [ ] Task 9: Staging and close-out (AC: 5, 8)
  - [ ] 9.1 `docs/migration/pilot-cutover-runbook.md` row 2.10i after 2.10h: rebuild, `db:migrate` (three tables, one column); re-apply the pilot roles file (one new `store_controller` grant); as `ceo1@` grant the inventory controller all three rights; as that controller create a group and assign one pilot SKU; check the group items read, the ungrouped report, and that `ceo1@`, the site head, the store controller and `accounts@` see the notifications.
  - [ ] 9.2 Operator task: run 2.10i on staging after the held deploy is released; record PASS in Completion Notes.
  - [ ] 9.3 Gates: `npx tsc --noEmit`, `npm run lint`, `prettier --check --end-of-line auto`, `schema-drift`, `story-2-1`, `story-2-10`, `story-1-11` notification suite, `site-head-role-pack`, `store-controller-role-pack`, `npm run verify:roles`, full `npm test`.
  - [ ] 9.4 `graphify update .` after the code changes.

Table 1 lists every route this story adds, its gate and its success answer.

Table 1: Item group routes

| Order | Method and path | Gate | Success |
|---|---|---|---|
| 1 | `GET /api/v1/item-groups/ungrouped-items` | `inventory` read | 200 `{ items, count }` |
| 2 | `GET /api/v1/item-groups/rights` | `ceo` or `finance_controller` | 200 `{ rights }` |
| 3 | `PUT /api/v1/item-groups/rights/:userId` | `ceo` or `finance_controller` | 200 rights row |
| 4 | `GET /api/v1/item-groups/recipients` | `ceo` or `finance_controller` | 200 `{ recipients }` |
| 5 | `POST /api/v1/item-groups/recipients` | `ceo` or `finance_controller` | 201 |
| 6 | `DELETE /api/v1/item-groups/recipients/:userId` | `ceo` or `finance_controller` | 204 |
| 7 | `GET /api/v1/item-groups` | `inventory` read | 200 `{ item_groups }` |
| 8 | `POST /api/v1/item-groups` | `inventory_controller` plus `create` | 201 group |
| 9 | `GET /api/v1/item-groups/:code/items` | `inventory` read | 200 `{ item_group, items }` |
| 10 | `GET /api/v1/item-groups/:code` | `inventory` read | 200 group |
| 11 | `PATCH /api/v1/item-groups/:code` | `inventory_controller` plus `edit` | 200 group |
| 12 | `DELETE /api/v1/item-groups/:code` | `inventory_controller` plus `delete` | 204 |

Routes 2 to 6 use no `requireRole` module gate, because `ceo` and `finance_controller` are provisioned on different modules. They rely on the standard authentication middleware and then call `assertHoldsAnyRole` in the handler, as the edge role gates do. Routes 8, 11 and 12 keep `requireRole({ module: 'inventory', functionScope: 'write' })` and then call `assertItemGroupRight`.

## Dev Notes

### Owner rulings 2026-10-02

1. Only `inventory_controller` holders change groups; `warehouse_manager` is excluded. Several holders may exist. Each holder has separately grantable `create`, `edit`, `delete` rights in any combination. Only CEO or Finance Head grants or revokes, audited. Delete needs the `delete` right and is refused for a group that ever had an item (default chosen: refuse with `ITEM_GROUP_IN_USE`, keep `ON DELETE RESTRICT`). Every change notifies the Table 2 roles plus a recipient list kept by CEO or Finance Head.
2. Name unique ignoring case: confirmed.
3. Clearing an item's group to none: allowed. Default chosen: set, change and clear all notify the same list.
4. `item_category`: kept untouched here; follow-up logged in `deferred-work.md` (D8).

Round 2, same day:

1. Finance Head is `finance_controller`: confirmed.
2. `cfo` is notified as part of the finance team: confirmed.
3. Store controller is a NEW role `store_controller`, distinct from `inventory_controller`. The inventory controller maintains groups and assignments; the store controller tracks inventory physically and is responsible for stores and warehouses. In 2.10 it only exists, is provisionable and receives notifications (D11).
4. Self-notification: no ruling in this round (closed in round 3).

Round 3, same day:

1. Actors are always notified of their own changes, including when on the recipient list; recipients are de-duplicated so each user gets one notification per change.
2. The pilot `store_controller` holder is the existing `warehouse_manager` holder: confirmed.

Table 2 maps the role names of the rulings to the role register keys of the access matrix section 2.

Table 2: Ruling roles and register keys

| Ruling name | Register key | Note |
|---|---|---|
| Inventory controller | `inventory_controller` | exists, multi-site |
| CEO | `ceo` | exists (Story 8.9), site scope |
| Finance Head | `finance_controller` | confirmed 2026-10-02 |
| Finance team | `finance_controller`, `cfo` | confirmed 2026-10-02 |
| Site head | `site_head` | exists (Story 1.16), notified at every site because groups are global |
| Store controller | `store_controller` | NEW in this story (Task 8); site scope |

### Decisions

- **D1 Tables live in `item_master.sql`.** 39 integration harnesses apply that file and never a new one; a separate file would leave the foreign key target missing in all of them.
- **D2 `item_group` schema.** `item_group_id UUID PK DEFAULT gen_random_uuid()`, `code TEXT NOT NULL`, `name TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'active'`, `ever_assigned BOOLEAN NOT NULL DEFAULT false`, `created_at`, `updated_at`; `uq_item_group_code UNIQUE (code)`, `chk_item_group_status`, `chk_item_group_code CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$')`, `chk_item_group_name CHECK (length(btrim(name)) BETWEEN 1 AND 120)`, `uq_item_group_name_ci` unique index on `lower(name)`. Guarded DO blocks.
- **D3 Rights reuse what exists.** Role membership stays in `user_role_assignments`, provisioned through SCIM or the roles file as for every role (Stories 1.15, 1.16); that path has no in-app granter, so the per-person create, edit, delete rights are a small projection gated by an in-handler role check, the same shape as the edge role gates and the Story 4.8 grant table. No new RBAC module, no change to `requireRole`.
- **D4 Deactivate keeps items.** Deactivating leaves assigned items in place; an inactive group takes no new assignment or grant.
- **D5 Assignment rides `item.updated`.** No new item event type; the notification is the addition.
- **D6 One shared guard.** `assertItemGroupAssignable` owns `ITEM_GROUP_NOT_FOUND` and `ITEM_GROUP_INACTIVE`; Story 4.8 Task 2.2 calls it for `scope_item_group_id` and reads membership through `getItemBySku`.
- **D7 Events stay route-only**, as `item.created` and `item.updated` (Story 2.1 precedent).
- **D8 `item_category` untouched.** Indent and PO lines are live pilot documents that already carry it; replacing it needs a row migration and every item grouped first. The ungrouped report is the tool that gets there. Logged in `deferred-work.md`.
- **D9 "Ever assigned" is a flag.** `markEverAssigned` sets `item_group.ever_assigned = true` on the first assignment and never clears it, so a group emptied later still cannot be deleted. Cheaper and exact compared with scanning `domain_events`.
- **D11 Store controller scope.** The register has no matching role: `warehouse_manager` (site; task assignment, transfer and count-adjustment approval) overlaps "responsible for stores and warehouses" but is an approver, not a custodian; `store_assistant` does physical putaway and counts but is a frontline hat; `rd_store_keeper` is R&D only. So `store_controller` is added, held by the pilot site's `warehouse_manager` holder (confirmed round 3), on module `warehouse` read so it grants no write power. Its physical-tracking capabilities are logged in `deferred-work.md` for a correct-course and a new story.
- **D10 Out of scope.** Group hierarchy, bulk assignment, edge UI, seeding groups, pagination, email channel (notifications use the in-app channel already dispatched).

### Current state of the files this story changes

- `read/projections/item_master.sql` and `deploy/compose/init-db.sql`: canonical and copy, pinned by `test/unit/schema-drift.test.ts:36-48`; keep all eight existing constraint names.
- `src/read/projections/item_master.ts`: `ITEM_COLUMNS` drives every select; about 30 importers, none builds an `ItemMaster` literal.
- `src/api/v1/items.ts`: POST and PATCH run BEGIN, projection write, `persistEvent` on stream `item_master`, COMMIT, gated by `inventory` write. Keep `DUPLICATE_SKU`, `VALUATION_METHOD_NOT_PERMITTED`, `INVALID_BUSINESS_STREAM`, the SKU regex.
- `src/notify/emit.ts`: `emitNotificationInTransaction(input, client)` writes a `notification.created` event; `src/notify/dispatch.ts` fans out by role and location or delivers to `target.user_id`. Reuse as is.
- `src/api/v1/edge.ts:150-165`: the role-in-handler gate pattern.
- `src/server.ts:571-573`: item routes.
- Access matrix sections 3.3, 3.8 and 9 (last changelog row v1.3).

### Architecture compliance

Singular entity names, past-tense dotted events, UUIDv4 ids, uniform error envelope, every mutation edit-logged with `trace_id`, AD-14 (other modules read through `item_group.ts`), AD-17 (notification emission is the caller's explicit in-transaction choice).

### Testing standards

`node:test` with `node:assert/strict`; local Postgres 18.4 test container on port 5442; several integration files need `--test-concurrency=1`; prettier needs `--end-of-line auto` on this checkout.

### Previous story intelligence

Stories 2.1 and 2.9 set the master-data pattern; Story 1.16 set exact-value tests with a negative control, red output first, untouched existing callers, a runbook row and an unchecked operator task. `git log -5`: `2ed08c8` Story 1.16 and docs; nothing touches the item master.

### Latest technical information

No new library. Postgres 18.4 supports the expression unique index and `FOR SHARE` used here.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 2.10]
- [Source: _bmad-output/implementation-artifacts/4-8-standing-approvals-and-self-approval-limits.md, D5, Task 2.2]
- [Source: _bmad-output/implementation-artifacts/1-16-site-head-role.md]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-Inventory Management System_2-2026-07-11/ARCHITECTURE-SPINE.md, AD-14, AD-17]
- [Source: _bmad-output/planning-artifacts/access-matrix-frontline-draft-2026-07-11.md, sections 2, 3.3, 9]
- [Source: src/notify/emit.ts; src/notify/dispatch.ts; src/api/v1/edge.ts; src/api/v1/items.ts; read/projections/item_master.sql]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Revised 2026-10-02 for owner rulings.

### File List
