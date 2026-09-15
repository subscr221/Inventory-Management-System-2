# Sprint Change Proposal: Refused and Parked Edge Captures Are Deleted at PowerSync Checkpoints

- Date: 2026-09-15
- Author: Developer agent (Correct Course workflow), with SCHOOL-PC
- Mode: incremental (all five edit proposals approved individually)
- Scope classification: Moderate (backlog addition and one architecture rule; no MVP change)
- Status: approved by SCHOOL-PC on 2026-09-15; edits in section 4 applied

## 1. Issue Summary

### Problem Statement

The edge PWA stores captures in the `edge_outbox` table, which is declared as a synced (non-`localOnly`) PowerSync table so that PowerSync's upload queue carries each capture to `POST /api/v1/edge/events`. PowerSync treats a synced table as a replica of server state: once the upload queue is empty it applies the server checkpoint and keeps only rows the server holds. A capture the central plane refuses is never held by the server, so the device deletes it. The same applies to captures parked for another signed-in user on a shared device (Story 1.12, review decision 1), whose upload-queue entry is completed so the current user's captures can flow.

Captures that upload successfully are not affected, because PowerSync applies a checkpoint only after the upload queue has drained. Captures still waiting in the queue, including rows parked `auth_required` for the current session, are not affected either.

### Discovery Context

The defect has existed since Story 1.8 but was unobservable: edge sync had never worked end to end on staging. It surfaced on 2026-09-14 during the Story 1.12 staging verification, after three PowerSync service configuration defects were fixed the same day (commits `f2d43df`, `9d1b346`, `8d5ad96` on branch `story/1-12-edge-sign-in`).

### Evidence

A browser-side recorder captured the shell counters while one "Capture Shell Test Event" was refused with HTTP 403 `MODULE_ACCESS_DENIED`. Table 1 lists the recorded timeline.

Table 1: Proof-capture timeline on staging (browser clock, 2026-09-14)

| Time | Pending | Needs attention | Status badge |
|---|---|---|---|
| 11:21:59.507 | 0 | 0 | Online |
| 11:21:59.507 | click | - | - |
| 11:21:59.530 | 1 | 0 | Captured - pending sync |
| 11:21:59.561 | 1 | 0 | Syncing... |
| 11:21:59.758 | 0 | 1 | Sync Error |
| 11:21:59.995 | 0 | 0 | Online |

The staging nginx log shows the same sequence (server clock about 95 seconds ahead): `POST /api/v1/edge/events 403` followed within a second by `GET /powersync/write-checkpoint2.json`. This violates the Story 1.8 acceptance criterion that a permanently rejected event moves to a visible "sync failed - needs attention" state on the device.

## 2. Impact Analysis

### Epic Impact

- Epic 1 (Platform Foundation, Compliance Spine, and Offline Edge Shell): marked `done`, but the Story 1.8 criterion does not hold on a connected device and Story 1.12 is still in progress. Epic 1 is reopened and gains Stories 1.13 and 1.14.
- Epic 7: the Story 7.8 failure list and stream-conflict parking read the same outbox rows. Regression testing is required; no scope change.
- Epics 3, 4 and 8: they add permanent error codes and inherit the fix without changes.
- No epic becomes obsolete and no new epic is needed.

### Story Impact

- Story 1.8: stays `done`; the defect is recorded against it and remedied by Story 1.13.
- Story 1.12: closes after runbook 2.10a and 2.10b; its owner re-queue check moves to Story 1.13 AC3.
- Story 1.13 (new, pre-pilot blocking): local-only retention plus central refusal records and API.
- Story 1.14 (new, pilot): supervisor screen for refused captures.

### Artifact Conflicts

Table 2 summarizes the artifacts reviewed and the outcome for each.

Table 2: Artifact impact

| Artifact | Conflict | Action |
|---|---|---|
| PRD (FR-M-17, Story 1.8 criterion) | None; the requirement already demands retention | No change |
| Architecture spine | No rule on device-only data or PowerSync configuration | Add AD-18 |
| UX (`DESIGN.md` Sync Error, `EXPERIENCE.md` sync-fail flow) | None; the designed behavior is correct | No change |
| Runbook section 2 | No end-to-end sync check | Add row 2.10c |
| Sprint status | Epic 1 marked done | Reopen, add 1.13 and 1.14 |
| Test strategy | No test drives a real PowerSync service | Story 1.13 AC5 |
| Deployment | None beyond the already-committed service fixes | No change |

### Technical Impact

- Edge: a `localOnly` retention table (the existing unused `sync_failures` table is a candidate); the connector copies a row before completing its queue entry when the server will not hold it; the failure list, counters, sign-out gate and owner re-queue read retained rows.
- Central: the edge upload path records every permanent refusal, for every module, as an event-sourced refused-capture record, extending the Story 7.8 maintenance sync-conflict pattern; a site-scoped, DOA-gated list and resolve API.
- The PowerSync upload loop, its retry and backoff, and Story 7.8 stream ordering are unchanged.

## 3. Recommended Approach

Selected path: Option 1, Direct Adjustment, using approach B (local-only retention copy) plus central refusal records chosen by the user for safety. Table 3 records the options considered.

Table 3: Options evaluated

| Option | Description | Effort | Risk | Verdict |
|---|---|---|---|---|
| 1A | Make `edge_outbox` local-only and replace the PowerSync upload queue with a custom scheduler | High | High | Rejected: reworks Stories 1.8 and 7.8 retry and ordering before the pilot |
| 1B | Keep the upload queue; copy refused and parked rows into a local-only table | Medium | Medium-low | Selected |
| 1B plus central records | 1B, and the server records every refusal centrally with a list and resolve API | Medium-high | Medium-low | Selected (user decision: a refusal must survive a reset or handed-over device) |
| 2 | Rollback | - | - | Not viable: nothing recent to revert; the flaw dates from Story 1.8 |
| 3 | MVP review | - | - | Not needed: scope unchanged |

Rationale: approach B closes the data loss without touching upload ordering, reuses the Story 1.12 delete-and-reinsert re-queue, and central records remove the dependency on any single device. The supervisor screen is split into Story 1.14 so the data-loss fix is not delayed by UI work.

Effort estimate: Story 1.13 about one and a half stories; Story 1.14 about one story. Timeline impact: the pilot rehearsal (runbook sections 3 to 7) waits for Story 1.13 and runbook row 2.10c.

## 4. Detailed Change Proposals

### 4.1 Stories: `epics.md`, Epic 1

New Story 1.13, inserted after Story 1.12:

```text
### Story 1.13: Refused and Parked Captures Are Never Lost (PRE-PILOT BLOCKING)

As a site supervisor,
I want every capture the central system refuses to stay visible on the device
and to land in a central refused-captures queue,
so that no stock movement silently disappears when a tablet syncs, is reset,
or changes hands.

AC1 Given a capture the central system permanently refuses
    When PowerSync applies its next checkpoint
    Then the capture is still listed as "Needs attention" on the device
    (local-only retention), with its error_code.
AC2 Given the same refusal
    When the server rejects the upload
    Then a refused-capture record (event_id, envelope, actor, site, error_code,
    trace_id, time) is written centrally for every module, event-sourced like
    the Story 7.8 sync-conflict queue.
AC3 Given captures parked for another person on a shared device (Story 1.12)
    When checkpoints apply
    Then they survive and re-queue when that person signs in.
AC4 Given a supervisor for the site
    When they call the refused-captures API
    Then they can list open refusals and mark one resolved with a note (DOA-gated).
AC5 Given the edge test suite
    When it runs
    Then at least one test drives a real PowerSync service through a
    refuse-then-checkpoint cycle; runbook section 2 gains the same manual check.
```

New Story 1.14, inserted after Story 1.13:

```text
### Story 1.14: Refused-Captures Supervisor Screen

As a site supervisor,
I want a screen listing the captures the central system refused at my site,
so that I can see who captured what, why it was refused, and close each one
with a note without calling an API by hand.

AC1 Given a signed-in user holding a supervisor role for the site
    (Story 1.2 role assignments)
    When they open /supervisor/refused-captures in the edge app
    Then they see open refusals for their site only: time, person, device,
    capture type, error_code with its operator message (en.json errors.*),
    newest first.
AC2 Given a user without a supervisor role
    When they open the page
    Then it is not shown in navigation and the API returns 403.
AC3 Given an open refusal
    When the supervisor marks it resolved with a mandatory note
    Then the Story 1.13 resolve API is called (DOA-gated), the row leaves the
    open list, and the resolution (who, when, note) stays visible under
    "Resolved".
AC4 Given the page
    When checked by the CI accessibility audit and keyboard-only pass
    Then it meets the same WCAG 2.1 AA bar as the Story 1.8 shell (NFR-U-02),
    with all copy from en.json.
AC5 Given the device is offline
    When the page is opened
    Then it states that the list needs a connection (no stale cache shown as
    current).

Dependencies: Story 1.13 (refused-captures API).
Priority: PILOT (not pre-pilot blocking). Until it ships, supervisors use the
1.13 API or a runbook report query.
```

### 4.2 Architecture: `ARCHITECTURE-SPINE.md`, Invariants and Rules

New rule after AD-17:

```text
### AD-18 - Device-Only Data Lives in Local-Only Tables; Refusals Are Recorded Centrally

- Binds: edge local schema (edge/src/local-db/schema.ts), upload connector
  (edge/src/sync/connector.ts), edge upload API, PowerSync service configuration
- Prevents: captures the central plane refused, or that are parked for another
  signed-in user, being silently deleted on the device when PowerSync applies a
  checkpoint; refusals leaving no trace when a device is reset or changes hands
- Rule: a synced (non-localOnly) PowerSync table is a replica of server state:
  at every checkpoint the device keeps only what the server holds. Data that exists
  only on the device (settled or parked outbox rows, failure lists, cached context)
  must live in localOnly tables. edge_outbox stays synced solely to ride the
  upload queue; before a row's queue entry completes without the server holding it,
  the connector copies it into a localOnly retention table. Independently, the
  central plane records every permanent edge-upload refusal (all modules) as an
  event-sourced refused-capture record, so a refusal survives the device (AD-14).
- Service configuration (self-hosted PowerSync 1.23.x): sync-token keys go under
  client_auth.jwks (an HS256 oct key with a kid matching the token header);
  the replication source goes under replication.connections; the Postgres
  publication must be named exactly powersync. Unknown top-level blocks such as
  jwt: or source: are ignored silently.
- Verified by: at least one test driving a real PowerSync service through a
  refuse-then-checkpoint cycle (Story 1.13 AC5); runbook section 2 manual check.
```

### 4.3 Runbook: `docs/migration/pilot-cutover-runbook.md`, Table 2

New row 2.10c after 2.10a; row 2.10b gains the prefix "Only after 2.10c passes."

```text
| 2.10c | Sync end to end (Story 1.13, AD-18), in a tab signed in as an account
  that holds an edge capture role for the site: (1) capture one event that the
  server accepts; the Pending count returns to 0 and the event appears in
  domain_events for the site. (2) Capture one event the server refuses (for
  example as a role without that module); after the next PowerSync checkpoint it
  must STILL show under "Needs attention" on the device with its error code, and
  the refused-captures API (Story 1.13) must list it for the site. (3) Reload the
  tab: the refusal is still on the device. (4) On the box, PowerSync logs show
  "Sync stream started" and no PSYNC_S2101; pg_replication_slots has an
  active powersync slot |
  accepted event row, refusal visible on device after checkpoint and reload,
  refused-captures API entry, active replication slot |
```

### 4.4 Sprint Status and Story 1.12

`sprint-status.yaml`, Epic 1 block:

```yaml
  epic-1: in-progress   # reopened 2026-09-15 by sprint-change-proposal-2026-09-15 (Stories 1.13, 1.14)
  1-8-offline-edge-pwa-shell-and-powersync-sync-layer: done   # PILOT  # AC "visible needs attention" fails on a connected device (staging 2026-09-14); remedied by Story 1.13, not reopened
  1-12-edge-ui-sign-in-through-keycloak-pkce: in-progress   # (existing comment kept) Closes after runbook 2.10a/2.10b; owner re-queue check verified under Story 1.13 AC3
  1-13-refused-and-parked-captures-are-never-lost: backlog   # PRE-PILOT BLOCKING  # sprint-change-proposal-2026-09-15; AD-18; blocks runbook 2.10c and the rehearsal
  1-14-refused-captures-supervisor-screen: backlog   # PILOT  # depends on 1-13
```

Story 1.12 file, Task 6.6, appended scope note:

```text
Scope note (sprint-change-proposal-2026-09-15): the owner re-queue check
(review decision 1) cannot pass until Story 1.13 retains parked rows across
PowerSync checkpoints; it moves to Story 1.13 AC3. Story 1.12 is done once
the remaining 6.6 items and runbook 2.10a/2.10b pass.
```

## 5. Implementation Handoff

Scope: Moderate. Table 4 assigns responsibilities.

Table 4: Handoff plan

| Role | Responsibility | Deliverable |
|---|---|---|
| Developer agent (this workflow) | Apply the approved edits in section 4 to `epics.md`, `ARCHITECTURE-SPINE.md`, the runbook, `sprint-status.yaml` and the Story 1.12 file | Updated artifacts |
| Scrum Master / create-story | Create the Story 1.13 file with full dev context (connector, schema, upload API, Story 7.8 sync-conflict pattern, real-PowerSync test harness) | `1-13-...md` ready-for-dev |
| Developer agent (dev-story) | Implement Story 1.13, then Story 1.14 | Code, tests, staging runbook 2.10c pass |
| Operator (SCHOOL-PC) | Provide a technician-role account for 2.10c and the owner re-queue check; finish Story 1.12 runbook 2.10a and 2.10b | Staging verification evidence |

Sequencing: close Story 1.12 (runbook 2.10a and 2.10b), create and implement Story 1.13, pass runbook 2.10c, then start the rehearsal; Story 1.14 ships before go-live.

Success criteria:

1. A refused capture stays visible on the device across checkpoints and a reload.
2. The same refusal is listed by the central refused-captures API for its site.
3. Parked captures for another user survive checkpoints and re-queue on that user's sign-in.
4. A real-PowerSync test in CI covers the refuse-then-checkpoint cycle.
5. Runbook row 2.10c passes on staging.
