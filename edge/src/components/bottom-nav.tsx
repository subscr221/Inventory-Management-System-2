'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { NavIcon } from './navigation/nav-icons';
import type { NavEntry } from './navigation/nav-model';
import { t, type MessageKey } from '../i18n/locale';

/** DESIGN.md bottom-nav: four slots at most; the fourth becomes More when anything overflows. */
const MAX_SLOTS = 4;

export interface BottomNavProps {
  entries: NavEntry[];
  /** The href of the entry the current view belongs to, if any. */
  activeHref: string | null;
  /** Sign-out lives in More here, because the sidebar that carries it is not rendered. */
  onSignOut?: (() => void) | undefined;
  signingOut?: boolean;
}

export function BottomNav({ entries, activeHref, onSignOut, signingOut = false }: BottomNavProps) {
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLLIElement>(null);
  const menuId = useId();

  const needsMore = entries.length > MAX_SLOTS || Boolean(onSignOut);
  const visible = needsMore ? entries.slice(0, MAX_SLOTS - 1) : entries;
  const overflow = needsMore ? entries.slice(MAX_SLOTS - 1) : [];
  const activeInOverflow = overflow.some((entry) => entry.href === activeHref);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  if (entries.length === 0 && !onSignOut) return null;

  return (
    <nav className="bottom-nav" aria-label={t('nav.bottomNav')}>
      <ul className="bottom-nav-list">
        {visible.map((entry) => (
          <li key={entry.href} className="bottom-nav-slot">
            <a
              className="bottom-nav-item"
              href={entry.href}
              aria-current={entry.href === activeHref ? 'page' : undefined}
            >
              <NavIcon name={entry.name} />
              <span className="bottom-nav-label">{t(entry.label as MessageKey)}</span>
            </a>
          </li>
        ))}
        {needsMore ? (
          <li className="bottom-nav-slot" ref={moreRef}>
            <button
              type="button"
              className={activeInOverflow ? 'bottom-nav-item active' : 'bottom-nav-item'}
              aria-expanded={open}
              aria-controls={menuId}
              onClick={() => setOpen((current) => !current)}
            >
              <NavIcon name="more" />
              <span className="bottom-nav-label">{t('nav.more')}</span>
            </button>
            <ul className="bottom-nav-more" id={menuId} hidden={!open}>
              {overflow.map((entry) => (
                <li key={entry.href}>
                  <a
                    className="bottom-nav-more-item"
                    href={entry.href}
                    aria-current={entry.href === activeHref ? 'page' : undefined}
                    onClick={() => setOpen(false)}
                  >
                    <NavIcon name={entry.name} />
                    {t(entry.label as MessageKey)}
                  </a>
                </li>
              ))}
              {onSignOut ? (
                <li>
                  <button
                    type="button"
                    className="bottom-nav-more-item"
                    onClick={onSignOut}
                    disabled={signingOut}
                    aria-busy={signingOut}
                  >
                    <NavIcon name="sign-out" />
                    {t('auth.signOut')}
                  </button>
                </li>
              ) : null}
            </ul>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
