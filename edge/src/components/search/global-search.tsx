'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n/locale';
import { buildNavigationStructure, KNOWN_ALIASES, type NavItem } from '../navigation/nav-model';

interface SearchResult {
  id: string;
  label: string;
  path: string;
  href: string;
}

interface GlobalSearchProps {
  currentRole?: string;
  allowedItems?: string[];
}

// Flatten the navigation tree into searchable entries, resolving every leaf to a route plus a
// human-readable breadcrumb path of its parent labels.
function flattenNav(items: NavItem[], ancestors: string[] = []): SearchResult[] {
  return items.flatMap((item) => {
    const path = [...ancestors, item.label];
    const own: SearchResult[] = item.href
      ? [{ id: item.id, label: item.label, path: path.join(' / '), href: item.href }]
      : [];
    const children = item.children ? flattenNav(item.children, path) : [];
    return [...own, ...children];
  });
}

function scoreMatch(label: string, path: string, query: string): number {
  const q = query.toLowerCase();
  const labelLower = label.toLowerCase();
  const pathLower = path.toLowerCase();

  if (labelLower === q) return 0;
  if (labelLower.startsWith(q)) return 1;
  if (labelLower.includes(q)) return 2;
  if (pathLower.includes(q)) return 3;
  return -1;
}

export function GlobalSearch({ currentRole = '', allowedItems }: GlobalSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);

  const navigationStructure = useMemo(() => buildNavigationStructure(), []);

  const index = useMemo(() => {
    const roleFiltered = navigationStructure.filter((item) => {
      if (item.roleAccess && !item.roleAccess.includes(currentRole)) return false;
      return true;
    });
    const results = flattenNav(roleFiltered);
    if (allowedItems && allowedItems.length > 0) {
      return results.filter((result) => {
        const alias = KNOWN_ALIASES[result.id];
        return alias ? allowedItems.includes(alias) : true;
      });
    }
    return results;
  }, [navigationStructure, currentRole, allowedItems]);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return index;
    return index
      .map((result) => ({ result, score: scoreMatch(result.label, result.path, trimmed) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => a.score - b.score || a.result.label.localeCompare(b.result.label))
      .map((entry) => entry.result);
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

  const navigateTo = useCallback((href: string) => {
    closeSearch();
    if (href.startsWith('#')) {
      window.location.hash = href;
    } else {
      window.location.assign(href);
    }
  }, [closeSearch]);

  // Keyboard shortcut: Ctrl/Cmd+K, or "/" when not typing in a field.
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
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
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
          <span aria-hidden="true" className="search-icon">{t('search.icon')}</span>
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
            <ul ref={resultsRef} className="search-results" role="listbox">
              {results.length === 0 ? (
                <li className="search-empty">{t('search.noResults')}</li>
              ) : (
                results.map((result, index) => (
                  <li key={result.id} role="option" aria-selected={index === activeIndex}>
                    <button
                      type="button"
                      className={`search-result ${index === activeIndex ? 'active' : ''}`}
                      data-active={index === activeIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => navigateTo(result.href)}
                    >
                      <span className="search-result-label">{result.label}</span>
                      <span className="search-result-path">{result.path}</span>
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
