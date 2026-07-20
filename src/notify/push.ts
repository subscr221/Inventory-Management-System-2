import webpush from 'web-push';
import { config } from '../config/index.js';

export interface PushSubscriptionTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSendResult {
  ok: boolean;
  failureReason: string | null;
}

let vapidConfigured = false;

function ensureVapidConfigured(): boolean {
  if (vapidConfigured) return true;
  if (!config.notify.vapidPublicKey || !config.notify.vapidPrivateKey) return false;
  webpush.setVapidDetails(config.notify.vapidSubject, config.notify.vapidPublicKey, config.notify.vapidPrivateKey);
  vapidConfigured = true;
  return true;
}

/**
 * Sends one web-push notification. Never throws - a provider/network failure or an unconfigured
 * VAPID key is reported back as a normal failed result, not an exception, so the dispatcher
 * (Task 3) can always record a delivery outcome and move on to the next recipient instead of
 * aborting the whole fan-out (AC4: emission/delivery must never block on a single failure).
 */
export async function sendPushNotification(subscription: PushSubscriptionTarget, payload: Record<string, unknown>): Promise<PushSendResult> {
  if (!ensureVapidConfigured()) {
    return { ok: false, failureReason: 'push_not_configured' };
  }
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
    );
    return { ok: true, failureReason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, failureReason: message };
  }
}
