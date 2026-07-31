---
diff_source: "git diff e97d657..c46fc21 (or: C:\Users\admin\AppData\Local\Temp\kilo\story-3-9-diff.txt)"
spec: "_bmad-output/implementation-artifacts/3-9-forward-pick-replenishment-fr-w-08.md"
repo: "C:\Users\admin\Documents\GitHub\Inventory-Management-System-2"
note: "Run in a fresh session (ideally a different LLM). Do not include the main session's prior context."
---

# Edge Case Hunter (manual run)

You are the Edge Case Hunter layer of an adversarial code review. You have NO prior conversation context — treat the diff as the only source of truth.

## Step 1

Read the skill instructions and follow them exactly:
`C:\Users\admin\Documents\GitHub\Inventory-Management-System-2\.agents\skills\bmad-review-edge-case-hunter\SKILL.md`

## Step 2

Apply that skill to the unified diff at:
`C:\Users\admin\AppData\Local\Temp\kilo\story-3-9-diff.txt`
(this is `git diff e97d657..c46fc21` of the repo at `C:\Users\admin\Documents\GitHub\Inventory-Management-System-2`).

You may read any file in the repo to verify context. The working tree reflects the post-diff state.

## Step 3

Walk every branching path and boundary condition. Report only unhandled edge cases. Each finding: one-line title, file:line, the boundary condition, what goes wrong, and a concrete repro. If none, say so explicitly — do not return empty.

## Specific things to pressure-test (from the story)

- Descendant-walk CTE depth-capped at 10 — what if a real hierarchy exceeds 10? What if a cycle exists?
- `stock_class = 'owned'` filter — does it correctly exclude consignment/VMI? What if a zone has no `owned` stock?
- Partial unique open-per-signal index — what if two trigger runs race? What if a task is `cancelled` (does the index still allow a new open one)?
- `completeReplenishmentTask` status-predicated update — what if a concurrent confirm + cancel hit? What if `from_location_id` is null at completion time (generator never resolved one)?
- `to_location_id` resolved at confirm time — what if the destination bin's parent chain doesn't descend from the task's `zone_id` (orphan bin)? What if the destination bin is the same as `from_location_id`?
- `correlation_id` reuse on both `applyStockIssue` and `applyStockReceipt` — verify it actually flows through both calls and onto the resulting `stock_balance` rows.
- Replay of `replenishment_task.created` with the same event_id — does the idempotency short-circuit fire before the partial-unique index would block a duplicate?
- `forward_pick_config.updated` event path — does the same id appear on subsequent GET? Does the assertion reject negative `min_qty` or `max_qty <= min_qty`?
- Site scoping via `permittedLocationsForModuleScope` — what about a config row whose `site_id` is in scope but the zone is at a different site? Cross-site config?
- `runForwardPickReplenishmentCheck` — what if the lock acquisition on `forward_pick_config` row fails or times out? What if a config's `zone_id` references an inactive/soft-deleted zone?
- RBAC: read-role list for confirm — does the spec's enumeration match what the code actually checks?
