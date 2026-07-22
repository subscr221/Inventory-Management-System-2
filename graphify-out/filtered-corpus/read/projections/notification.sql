-- Story 1.11: Notification and Alerting Foundation.
-- Notifications are fanned out from `notification.created` domain events (stream_type
-- 'notification') into one row per recipient here, so the API can list/filter without scanning
-- domain_events. deploy/compose/init-db.sql mirrors these table definitions (plus grants) for
-- first-time cluster init; keep the two in sync.

CREATE TABLE IF NOT EXISTS notifications (
  notification_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id       UUID NOT NULL,
  target_user_id        UUID NOT NULL REFERENCES users(user_id),
  target_role           TEXT NOT NULL,
  target_location_id    UUID,
  event_type            TEXT NOT NULL,
  status_verb           TEXT NOT NULL,
  object_type           TEXT NOT NULL,
  object_id             TEXT NOT NULL,
  actor_label           TEXT,
  next_step             TEXT,
  status                TEXT NOT NULL DEFAULT 'created',
  occurred_at            TIMESTAMPTZ NOT NULL,
  read_at                TIMESTAMPTZ,
  acted_upon_at          TIMESTAMPTZ,
  expired_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_notifications_event_user UNIQUE (source_event_id, target_user_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_notifications_status'
      AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT chk_notifications_status CHECK (status IN ('created', 'read', 'acted_upon', 'expired'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_target_user ON notifications (target_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_event_type ON notifications (target_user_id, event_type);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id   UUID NOT NULL REFERENCES notifications(notification_id),
  channel           TEXT NOT NULL,
  outcome           TEXT NOT NULL,
  trace_id          TEXT NOT NULL,
  failure_reason    TEXT,
  delivered_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_notification_deliveries_channel'
      AND conrelid = 'notification_deliveries'::regclass
  ) THEN
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT chk_notification_deliveries_channel CHECK (channel IN ('in_app', 'web_push'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_notification_deliveries_outcome'
      AND conrelid = 'notification_deliveries'::regclass
  ) THEN
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT chk_notification_deliveries_outcome CHECK (outcome IN ('delivered', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification ON notification_deliveries (notification_id);

-- Tracks which domain_events (stream_type 'notification', event_type 'notification.created')
-- the dispatcher has already fanned out, so a restarted dispatcher resumes instead of
-- reprocessing every event from the beginning of the stream, and never double-processes one
-- that produced zero eligible recipients (which would otherwise never appear in `notifications`).
CREATE TABLE IF NOT EXISTS notification_dispatch_log (
  source_event_id   UUID PRIMARY KEY,
  dispatched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retry bookkeeping for events the dispatcher FAILED to fan out. A row exists only while an
-- event is failing (deleted again on successful dispatch), so the table stays tiny. Failed
-- events retry with exponential backoff via next_attempt_at (the dispatcher's fetch skips rows
-- not yet due), and after the configured attempt cap they are marked dead - excluded from
-- dispatch entirely and surfaced to operators via a dead-letter alert - instead of retrying
-- forever at the front of the oldest-first queue and starving every event behind them.
CREATE TABLE IF NOT EXISTS notification_dispatch_attempts (
  source_event_id   UUID PRIMARY KEY,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  dead              BOOLEAN NOT NULL DEFAULT false,
  last_error        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per ALERT (source_event_id - the original notification.created event, which may fan
-- out to several recipients) that carries an escalation definition. Keyed by source_event_id
-- rather than notification_id because acknowledgment by ANY one recipient resolves the whole
-- alert - the escalation window is a property of the alert, not of a single recipient's copy of
-- it. `resolved` flips to true on acknowledgment or escalation so the poll loop below stops
-- considering it.
CREATE TABLE IF NOT EXISTS notification_escalation_defs (
  source_event_id                UUID PRIMARY KEY,
  origin_target_role             TEXT NOT NULL,
  escalation_target_role        TEXT NOT NULL,
  acknowledgment_window_seconds INTEGER NOT NULL,
  deadline_at                   TIMESTAMPTZ NOT NULL,
  resolved                      BOOLEAN NOT NULL DEFAULT false,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_notification_escalation_defs_window'
      AND conrelid = 'notification_escalation_defs'::regclass
  ) THEN
    ALTER TABLE notification_escalation_defs
      ADD CONSTRAINT chk_notification_escalation_defs_window CHECK (acknowledgment_window_seconds > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notification_escalation_defs_due
  ON notification_escalation_defs (deadline_at)
  WHERE resolved = false;

-- Records every escalation hop (AC2: "every hop is recorded").
CREATE TABLE IF NOT EXISTS notification_escalations (
  escalation_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_event_id           UUID NOT NULL,
  from_target                TEXT NOT NULL,
  to_target                  TEXT NOT NULL,
  resolved_via                TEXT NOT NULL,
  escalated_source_event_id UUID,
  escalated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_escalations_source_event ON notification_escalations (source_event_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(user_id),
  endpoint          TEXT NOT NULL,
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_push_subscriptions_user_endpoint UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);

-- Per-event-type push opt-in (default off, DPDP/GDPR - EXPERIENCE.md section 13.2). In-app
-- delivery is never gated by this table; only web_push is.
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id       UUID NOT NULL REFERENCES users(user_id),
  event_type    TEXT NOT NULL,
  opted_in      BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_type)
);

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT INSERT, SELECT, UPDATE ON notifications TO app_user;
    GRANT INSERT, SELECT ON notification_deliveries TO app_user;
    GRANT INSERT, SELECT ON notification_dispatch_log TO app_user;
    GRANT INSERT, SELECT, UPDATE, DELETE ON notification_dispatch_attempts TO app_user;
    GRANT INSERT, SELECT, UPDATE ON notification_escalation_defs TO app_user;
    GRANT INSERT, SELECT ON notification_escalations TO app_user;
    GRANT INSERT, SELECT, UPDATE, DELETE ON push_subscriptions TO app_user;
    GRANT INSERT, SELECT, UPDATE ON notification_preferences TO app_user;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'readonly_user') THEN
    GRANT SELECT ON notifications TO readonly_user;
    GRANT SELECT ON notification_deliveries TO readonly_user;
    GRANT SELECT ON notification_dispatch_log TO readonly_user;
    GRANT SELECT ON notification_dispatch_attempts TO readonly_user;
    GRANT SELECT ON notification_escalation_defs TO readonly_user;
    GRANT SELECT ON notification_escalations TO readonly_user;
    GRANT SELECT ON push_subscriptions TO readonly_user;
    GRANT SELECT ON notification_preferences TO readonly_user;
  END IF;
END $$;
