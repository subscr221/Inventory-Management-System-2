---
title: 'Story 4.13 Requisition Ask for Info'
type: 'feature'
created: '2026-11-22'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
final_revision: '17b59a42d80f10639cc32a4adcdb0843a2edf68b'
baseline_revision: '4dbf95caa7a7ba1e4de3e9ac050b4b3f67aa90d2'
context:
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/sprint-change-proposal-2026-10-21.md
  - _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/EXPERIENCE.md
  - _bmad-output/planning-artifacts/ux-designs/ux-Inventory Management System_2-2026-09-23/mockups/key-approvals.html
  - _bmad-output/implementation-artifacts/4-12-approvals-inbox-and-requisition-approval-detail.md
  - _bmad-output/implementation-artifacts/4-11-stores-counter-issue-against-a-requisition.md
  - src/api/v1/indents.ts
  - src/compliance/indent.ts
  - src/read/projections/indent.ts
  - edge/src/components/approvals.tsx
  - edge/src/components/my-requests.tsx
  - edge/src/messages/en.json
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** An approver holding a pending requisition line can only approve or reject; the 4.12 detail has no way to ask the requester a question first (audit gap G06 residual, EXPERIENCE.md:137).

**Approach:** Add an online-only `POST /api/v1/indents/:indentId/request-info` that persists one `indent.info_requested` event through the 4.3 decision seam (no line status change), project it to a new `indent_info_request` table, notify the requester, expose it on the indent read endpoints, and render it in the 4.12 detail, inbox row and My requests card.

## Boundaries & Constraints

**Always:** Same gate and per-line guards as approve (`requireRole` base+procurement write, `assertLineDecisionAllowed` with decision `rejected` so the requester is always refused). Event, read row, audit entry, notification in ONE transaction. Replay-safe (`alreadyPersisted`, route fixes `info_request_id` before `persistEvent`). Q27: one open question per requisition view, a newer one replaces the status block text (history stays in `info_requests[]`). Q28: `indent_info_requested` joins `KNOWN_EVENT_TYPES`. Every UI string is an `en.json` key (i18n-literals test). Lint, prettier, `tsc` clean.

**Block If:** the owner would need to rule on a reply channel, a line-scoped question UI, or new notification surfaces (all deferred, not blocking).

**Never:** requester reply channel, edge notifications bell or in-app notification display, line-scoped question picker, damage-case or grant folding into `/approvals` (record in `_bmad-output/implementation-artifacts/deferred-work.md`, do not build). No offline queue or outbox for this action. No change to `line_status`, header status or `indent.approved`/`indent.rejected` behaviour. No edits to `sprint-status.yaml`. Staging deploy rows are not part of this story; nothing here needs a human outside the repo.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ask, default lines | `{question}` by line approver, header `raised` | 200, event persisted, lines stay pending, requester notified | none |
| Ask by delegate | active delegate of the line approver | same as above | none |
| Blank question | `"  "` or missing | nothing written | 400 `INDENT_INFO_QUESTION_REQUIRED` |
| Requester asks | actor is `requester_user_id` | nothing written | 403 `INDENT_RAISER_CANNOT_APPROVE` |
| Not the approver | holds none of the lines | nothing written | 403 `NOT_RESOLVED_APPROVER` |
| Decided line | named line not pending | nothing written | 409 `INDENT_LINE_ALREADY_DECIDED` |
| `pending-confirmation` header | duplicate hold | nothing written | 409 `INDENT_PENDING_CONFIRMATION` (existing `assertHeaderDecidable`) |
| Uploaded event | `indent.info_requested` via events door or edge door | nothing written | 403 `FUNCTION_ACCESS_DENIED` / 403 `CENTRAL_ONLY_OPERATION` |
| Second question | already one open | `info_requests[0]` is the newer one | none |

</intent-contract>

## Code Map

All epics anchors were re-verified at HEAD 4dbf95c; these DRIFTED (use the right column):
- epics `indents.ts:1142-1150` approve gate -- now `indents.ts:1137-1170` (`approveIndentBase`), gate `:1311-1314`; `resolveDecisionLineIds` now `:1098-1126` (not `:929-948`); `getIndentBase` now `:417-470`
- epics `compliance/indent.ts:35-45` verified; `decideAsApprover` now `:952-986`, `assertLineDecisionAllowed` `:894-949`, `applyLineDecision` `:993-1137` (audit `:1046`, notification `:1089`); dispatcher switch `:347`; shape asserts `:81`
- epics `store.ts:1183` -- now `src/events/store.ts:1193` (`applyIndentProjection`)
- epics `events.ts:557-569` verified `:557-569`; `upload.ts:385-398` -- now `:399-411` (`assertEdgeIndentIssueEventRefused`, called `src/api/v1/edge.ts:716`, not `:554`)
- epics `notification.ts:34` verified; `listIndents` is `src/read/projections/indent.ts:286` (not `:266`), `LINE_COUNT_SELECT` `:86`
- epics `story-4-11.test.ts:636/:939` verified; `story-1-9.test.ts` route list now `:385-397`; `server.ts:1458` -- notifications routes are `:1503`, the approve route is registered at `:883` (import `:188`); `my-requests.tsx` fetch is `:255`
- Additional: `src/events/schema.ts` event registry (`:6151` pattern, payload types `:1130`), `src/events/migrate.ts:61` SQL list, `test/unit/schema-drift.test.ts:565` table entries, `test/integration/story-4-12.test.ts:173` TRUNCATE list
- Mock anchors (key-approvals.html L546, L710-714, L733) verified.

Files:
- `src/compliance/indent.ts` -- seam: add type, shape assert, applier
- `src/api/v1/indents.ts` -- new route and `getIndentBase` response
- `edge/src/components/approvals.tsx`, `approvals-model.ts` -- detail footer, status block, inbox chip
- `edge/src/components/my-requests.tsx` -- card chip and question

## Tasks & Acceptance

**Execution:**
- [x] `read/projections/indent_info_request.sql` (new) and `deploy/compose/init-db.sql` -- idempotent `indent_info_request` (info_request_id UUID PK, indent_id, line_ids UUID[], question, asked_by_user_id, asked_at, source_event_id UNIQUE, index on indent_id, asked_at) -- read model, both files change together
- [x] `src/events/migrate.ts`, `test/unit/schema-drift.test.ts`, `test/integration/story-4-12.test.ts` and 4-11 truncate lists -- register the new file, table and index; truncate in tests
- [x] `src/events/schema.ts` -- `IndentInfoRequestedPayload` and registry entry `indent.info_requested` (procurement, `requiresBusinessStream: false`)
- [x] `src/read/projections/indent.ts` -- `insertIndentInfoRequest`, `listInfoRequestsByIndent` (newest first), grouped latest-question subquery joined into `listIndents` as `info_requested` (no N+1)
- [x] `src/compliance/indent.ts` -- add `indent.info_requested` to `INDENT_EVENT_TYPES`, shape assert (UUID ids, non-blank question, max 2000), `applyIndentInfoRequested`: lock header, `assertHeaderDecidable`, per-line `assertLineDecisionAllowed(..., 'rejected')`, insert row, `logAuditEntry` (`error_code: 'indent.info_requested'`), `emitNotificationInTransaction` (`indent_info_requested`, target `{ role, user_id: requester }`)
- [x] `src/api/v1/indents.ts` -- `requestInfoIndentBase` (trim question, 400 if blank, `resolveDecisionLineIds`, persist, return like approve) plus `requestInfoIndentHandler` with the approve gate; `getIndentBase` adds `info_requests[]` (`info_request_id`, `line_ids`, `question`, `asked_by` display name, `asked_at`)
- [x] `src/server.ts` and `test/integration/story-1-9.test.ts` -- register `POST /api/v1/indents/:indentId/request-info` and add to `allowedSpineRoutes`
- [x] `src/api/v1/events.ts`, `src/sync/upload.ts` -- refuse `indent.info_requested` (403 `FUNCTION_ACCESS_DENIED` / `CENTRAL_ONLY_OPERATION`)
- [x] `src/api/v1/notification.ts` -- add `indent_info_requested` to `KNOWN_EVENT_TYPES`
- [x] `edge/src/components/approvals-model.ts`, `approvals.tsx` -- types; `Ask for info` secondary beside Reject (only when online, a pending-for-me line has `approval_route === 'doa'`, no confirmation); textarea + hint + disabled `Send question` + `Cancel`; status block from `info_requests[0]`; `Info asked` chip on rows with `info_requested` (row stays Waiting)
- [x] `edge/src/components/my-requests.tsx` -- `info_requested` on `MyIndentRow`; chip, question and date on `RequisitionCard`
- [x] `edge/src/messages/en.json` -- `approvals.info.*` and `myRequests.infoRequest.*` keys
- [x] `test/integration/story-4-13.test.ts` (new), `edge/test/unit/approvals-model.test.ts`, `edge/test/fixtures/approvals-stub.ts`, `edge/test/e2e/approvals.spec.ts` -- cover every matrix row and the ACs; one e2e for ask, send, status block, offline hides Ask
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- append the three deferred items

**Acceptance Criteria:**
- Given a `raised` indent, when the line approver (or active delegate) posts a question, then one `indent.info_requested` event, one `indent_info_request` row, one audit entry and one notification exist, lines stay `pending`
- Given the I/O matrix error rows, when each is attempted, then the stated code returns and no event, row or notification is written
- Given an uploaded `indent.info_requested` on either door, when sent, then it is refused with the stated 403 and the route is in `allowedSpineRoutes`
- Given info requests exist, when `GET /indents/:id` and `GET /indents` are read, then `info_requests[]` and list `info_requested` carry the latest question
- Given the Handheld detail online, when `Ask for info` is sent, then the status block `Info asked, <when>` plus `"<question>" - you can still decide.` shows and the row keeps Waiting; offline shows only the 4.12 offline block
- Given the requester's My requests, when `info_requested` is set, then the card shows the `Info asked` chip and question; `GET /notifications` returns the `indent_info_requested` row

## Spec Change Log

## Review Triage Log

### 2026-11-22 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 2, low 1)
- defer: 9: (high 0, medium 4, low 5)
- reject: 5
- addressed_findings:
  - `[medium]` `[patch]` Over-length question was not refused at the route; added 400 `INDENT_INFO_QUESTION_TOO_LONG` in `src/api/v1/indents.ts`, the `errors.` message key, and an integration row in `test/integration/story-4-13.test.ts`.
  - `[medium]` `[patch]` Whitespace-only question passed the seam assert; `src/compliance/indent.ts` now trims before the non-empty check (no seam-level test added; the route trims first).
  - `[low]` `[patch]` Status block and Ask-for-info footer showed on decided requisitions; `edge/src/components/approvals.tsx` gates both on header `raised` and non-empty `pending_for_me_line_ids` (no decided-requisition fixture test added; needs new fixtures).

## Design Notes

Payload: `{ indent_id, info_request_id, line_ids, question }`; the route mints `info_request_id` so a replay writes the same row. Q27 is satisfied by display (latest wins) while all rows persist. `Ask for info` is hidden when no pending-for-me line routes through `doa` (standing or self-approval lines), per mock L735-736.

## Verification

**Commands:**
- `npx tsc --noEmit && npm run lint && npm run format:check` -- expected: clean (autocrlf may redden prettier on Windows; see local-test-environment)
- `node --env-file=.env.test --import tsx --test --test-concurrency=1 test/integration/story-4-13.test.ts test/integration/story-4-12.test.ts test/integration/story-4-11.test.ts test/integration/story-1-9.test.ts test/unit/schema-drift.test.ts` -- expected: pass
- `cd edge && npm run typecheck && npm run lint && npm test` -- expected: pass (includes i18n-literals)
- `cd edge && npx playwright test test/e2e/approvals.spec.ts` -- expected: pass

## Auto Run Result

- status: done
- Summary: Story 4.13 implemented. `POST /api/v1/indents/:indentId/request-info` persists `indent.info_requested` through the decision seam, writes the `indent_info_request` read row, one audit entry and a requester notification in one transaction. Doors refuse uploads (events 403 `FUNCTION_ACCESS_DENIED`, edge 403 `CENTRAL_ONLY_OPERATION`). Detail adds `info_requests[]`; list rows add `info_requested`. Edge approvals detail gets the Ask for info footer and `Info asked` block; My requests gets the chip and question.
- Review triage (pass 1): patch 3 applied (over-length 400 `INDENT_INFO_QUESTION_TOO_LONG`, whitespace-only refusal at seam, status-block guard), defer 9 appended to deferred-work.md, reject 5, no intent gaps, no bad_spec loopbacks.
- Verification: root `npm test` 2825/2825 pass before patch pass; story-4-13 + schema-drift 212/212 after patch; edge unit 243/243; Playwright approvals 14/14; tsc clean root and edge.
- Residual risks: server does not enforce DOA-only route for Ask for info (UI-only, deferred, needs owner ruling); no replay protection on retried POST; listIndents info chip persists after requisition is decided; list query scans full info-request table; no Playwright test for My requests chip or the hidden status block on decided requisitions.
- operator_actions: none (no acceptance criterion requires a human outside the repo).
- followup_review_recommended: false (3 small patches, localized consequence).
