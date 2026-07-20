# ADR-001: Notification Emission Coupling

## Status

Adopted on 2026-07-21. One dissent is recorded in the Dissent section and
stands as the trigger for any future revisit.

## Context

Story 1.11 built the notification foundation as a transactional outbox:
`domain_events` is the outbox table, `notification.created` rows are the
outbox records, and the dispatcher (`src/notify/dispatch.ts`) is the polling
relay that fans them out with an atomic claim. This matches the canonical
reliability pattern described by
[microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)
and [AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html):
at-least-once delivery from the relay, idempotent consumers
(`insertNotification` is unique on `source_event_id` plus `target_user_id`).

The open question was which coupling an emitting module gets by default.
`src/notify/emit.ts` exposes two entry points, contrasted in Table 1.

| Entry point | Transaction coupling | Failure behavior | Guarantee for the caller |
|:---|:---|:---|:---|
| `emitNotification()` | None: own connection, own commit | Never throws; failure is swallowed and returned as `ok: false` | The caller's business write can never be blocked or aborted by emission (Story 1.11 AC4) |
| `emitNotificationInTransaction()` | Joins the caller's open transaction | Throws; the caller's transaction rolls back as a unit | The business write and its notification commit atomically, or neither does |

Table 1: The two emission entry points and the guarantee each one trades away.

Both writes target the same PostgreSQL instance, so the decoupled default
protects against less than it appears to: if the event insert fails because
the database is down, the caller's own write was already at risk. What it
does protect against is a programming error in the emission payload (for
example a constraint violation) aborting an unrelated, already-valid
business write.

## Decision

1. `emitNotification()` remains the default entry point, preserving the
   explicit AC4 product decision: ordinary status notifications must never
   block or abort the emitting module's write path.
2. Flows where the notification is part of the business fact itself MUST use
   `emitNotificationInTransaction()`. In this codebase that class is:
   approval and rejection decisions, DOA delegation notices, and any
   statutory communication whose absence would make the committed business
   record incomplete. If losing the notification while keeping the write
   would misrepresent what happened, the flow is in this class.
3. System cycles use the entry point that matches their own transaction
   scope. The escalation cycle (`src/notify/escalate.ts`) uses in-transaction
   emission so a hop commits atomically with its claim; the dispatcher's
   dead-letter alert uses the decoupled default because it runs outside any
   transaction.

## Consequences

- Callers of `emitNotification()` accept possible silent loss of a
  notification when the emission write fails; the result object reports
  `ok: false` for callers that choose to log or react.
- Callers of `emitNotificationInTransaction()` accept that a broken emission
  aborts their business write loudly at commit time.
- The classification in the Decision section is a review-time obligation
  until enforcement lands: pull requests adding approval or delegation flows
  must be checked against it.

## Enforcement

A custom ESLint rule (patterned on
`eslint-rules/no-hardcoded-role-in-workflow.js`, the Story 1.4 precedent for
encoding an architecture decision as a CI-runnable check) is deferred: no
approval-workflow call sites exist yet, so a rule today would have nothing
to bind against and no examples to calibrate on. The trigger for writing it
is the first approval or delegation flow that emits a notification. Until
then this ADR plus code review carry the policy.

## Dissent

Winston (architect) holds that the defaults are inverted: the transactional
entry point is the textbook outbox form, it adds no failure modes when both
writes share one database, and a payload bug surfacing loudly at commit time
is preferable to a notification vanishing quietly. The room adopted the
current defaults 4-1 on the strength of AC4 being an explicit product
decision. If AC4 is ever renegotiated, this dissent is the starting point.

## References

- [Transactional outbox pattern, microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)
- [Transactional outbox pattern, AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)
- [Outbox pattern for reliable event publishing, Conduktor](https://www.conduktor.io/glossary/outbox-pattern-for-reliable-event-publishing)
- Architecture spine invariant AD-17 (this decision's one-paragraph canonical form)
- Story 1.11 implementation artifact:
  `_bmad-output/implementation-artifacts/1-11-notification-and-alerting-foundation.md`
