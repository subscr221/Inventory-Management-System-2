import { NavIcon } from './navigation/nav-icons';
import type { NavEntry } from './navigation/nav-model';
import { t, type MessageKey } from '../i18n/locale';

export interface IconRailProps {
  entries: NavEntry[];
  /** The href of the entry the current view belongs to, if any. */
  activeHref: string | null;
  /** Collapsed (icons only, label as tooltip) by default; expanded shows the labels beside them. */
  expanded?: boolean;
  onSignOut?: (() => void) | undefined;
  signingOut?: boolean;
}

/**
 * DESIGN.md icon-rail: the collapsed dark navigation. Collapsed items carry their label as the
 * accessible name and as the native tooltip, so the rail can scroll without clipping a custom one.
 */
export function IconRail({
  entries,
  activeHref,
  expanded = false,
  onSignOut,
  signingOut = false,
}: IconRailProps) {
  return (
    <nav
      className={expanded ? 'icon-rail icon-rail-expanded' : 'icon-rail'}
      aria-label={t('nav.label')}
    >
      <div className="icon-rail-inner">
        <ul className="icon-rail-list">
          {entries.map((entry) => {
            const label = t(entry.label as MessageKey);
            return (
              <li key={entry.href}>
                <a
                  className="icon-rail-item"
                  href={entry.href}
                  aria-label={label}
                  title={expanded ? undefined : label}
                  aria-current={entry.href === activeHref ? 'page' : undefined}
                >
                  <NavIcon name={entry.name} />
                  {expanded ? <span className="icon-rail-label">{label}</span> : null}
                </a>
              </li>
            );
          })}
        </ul>
        {onSignOut ? (
          <div className="icon-rail-footer">
            <button
              type="button"
              className="icon-rail-item"
              aria-label={t('auth.signOut')}
              title={expanded ? undefined : t('auth.signOut')}
              onClick={onSignOut}
              disabled={signingOut}
              aria-busy={signingOut}
            >
              <NavIcon name="sign-out" />
              {expanded ? <span className="icon-rail-label">{t('auth.signOut')}</span> : null}
            </button>
          </div>
        ) : null}
      </div>
    </nav>
  );
}
