'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t, type MessageKey } from '../../i18n/locale';
import { entriesFor, type NavEntry } from '../navigation/nav-model';

interface GlobalSearchProps {
  currentRole?: string;
  navigation?: string[];
}

function scoreMatch(label: string, query: string): number {
  const q = query.toLowerCase();
  const labelLower = label.toLowerCase();
  if (labelLower === q) return 0;
  if (labelLower.startsWith(q)) return 1;
  if (labelLower.includes(q)) return 2;
  return -1;
}

export function GlobalSearch({ currentRole = '', navigation = [] }: GlobalSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);

  void currentRole;

  const index = useMemo<NavEntry[]>(() => entriesFor(navigation), [navigation]);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return index;
    return index
      .map((entry) => ({
        entry,
        score: scoreMatch(t(entry.label as MessageKey), trimmed),
      }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((item) => item.entry);
  }, [query, index]);

  const openSearch = useCallback(() => {
    setOpen(true);
    setQuery('');
    setActiveIndex(0);
  }, []);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const navigateTo = useCallback(
    (href: string) => {
      closeSearch();
      if (href.startsWith('#')) {
        window.location.hash = href;
      } else {
        window.location.assign(href);
      }
    },
    [closeSearch],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'k') {
          event.preventDefault();
          openSearch();
        }
        return;
      }
      if (event.key === 'Escape' && open) {
        closeSearch();
        return;
      }
      if (event.key === '/' && !open) {
        const target = event.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable)
        ) {
          return;
        }
        event.preventDefault();
        openSearch();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, openSearch, closeSearch]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = results[activeIndex];
      if (selected) navigateTo(selected.href);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  };

  useEffect(() => {
    const el = resultsRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <>
      <div className="global-search">
        <button
          type="button"
          className="global-search-trigger"
          onClick={openSearch}
          aria-label={t('search.openLabel')}
        >
          <span aria-hidden="true" className="search-icon">
            {t('search.icon')}
          </span>
          <span className="search-placeholder">{t('search.placeholder')}</span>
          <kbd className="search-kbd">{t('search.shortcut')}</kbd>
        </button>
      </div>

      {open && (
        <div className="search-overlay" role="dialog" aria-modal="true" aria-label={t('search.title')}>
          <div className="search-modal">
            <input
              ref={inputRef}
              className="search-input"
              type="text"
              value={query}
              placeholder={t('search.placeholder')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label={t('search.inputLabel')}
            />
            <ul ref={resultsRef} className="search-results">
              {results.length === 0 ? (
                <li className="search-empty">{t('search.noResults')}</li>
              ) : (
                results.map((result, index) => (
                  <li key={result.href}>
                    <button
                      type="button"
                      className={`search-result ${index === activeIndex ? 'active' : ''}`}
                      data-active={index === activeIndex}
                      aria-current={index === activeIndex ? 'true' : undefined}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => navigateTo(result.href)}
                    >
                      <span className="search-result-label">
                        {t(result.label as MessageKey)}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <div className="search-footer">
              <span>{t('search.navigateHint')}</span>
              <button type="button" className="search-close" onClick={closeSearch}>
                {t('search.close')}
              </button>
            </div>
          </div>
          <div className="search-overlay-backdrop" onClick={closeSearch} />
        </div>
      )}
    </>
  );
}
