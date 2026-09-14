'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { t } from '../../../src/i18n/locale';
import { loadAuthConfig } from '../../../src/session/auth-config';
import { createBrowserSession } from '../../../src/session/session';

/**
 * Story 1.12 (AC1): Keycloak returns here after login. The session completes the PKCE code
 * exchange and the user lands on the screen they originally asked for. This route is not part of
 * the service worker's precached shell and is never a valid post-login destination itself.
 */
// The authorization code and PKCE state can be redeemed exactly once. A module-level single flight
// keeps a re-run effect (React StrictMode in development) from redeeming them a second time.
let pendingCallback: { href: string; result: Promise<{ returnTo: string }> } | null = null;

function completeCallback(href: string): Promise<{ returnTo: string }> {
  if (pendingCallback?.href !== href) {
    pendingCallback = {
      href,
      result: (async () => {
        const session = await createBrowserSession(await loadAuthConfig());
        try {
          return await session.handleCallback(href);
        } finally {
          session.dispose();
        }
      })(),
    };
  }
  return pendingCallback.result;
}

export default function AuthCallbackPage() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function complete() {
      try {
        const { returnTo } = await completeCallback(window.location.href);
        if (!cancelled) router.replace(returnTo);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void complete();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main id="main-content" className="edge-main auth-callback" tabIndex={-1}>
      {failed ? (
        <section className="edge-card" role="alert" aria-labelledby="auth-callback-heading">
          <h2 id="auth-callback-heading">{t('auth.callbackFailed')}</h2>
          <a className="primary-action" href="/">
            {t('auth.callbackRetry')}
          </a>
        </section>
      ) : (
        <p role="status" aria-live="polite">
          {t('auth.signingIn')}
        </p>
      )}
    </main>
  );
}
