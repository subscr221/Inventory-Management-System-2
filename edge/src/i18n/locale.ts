import en from '../messages/en.json';

export type MessageKey = keyof typeof en;

type Catalog = Record<MessageKey, string>;

const catalogs: Record<string, Catalog> = {
  en,
};

export const DEFAULT_LOCALE = 'en';

export function availableLocales(): string[] {
  return Object.keys(catalogs);
}

export function resolveLocale(requested?: string | null): string {
  if (requested && catalogs[requested]) return requested;
  if (requested) {
    const base = requested.split('-')[0];
    if (base && catalogs[base]) return base;
  }
  return DEFAULT_LOCALE;
}

function activeLocale(): string {
  const requested =
    typeof navigator !== 'undefined' && navigator.language ? navigator.language : DEFAULT_LOCALE;
  return resolveLocale(requested);
}

export function t(key: MessageKey, locale = activeLocale()): string {
  const catalog = catalogs[locale] ?? catalogs[DEFAULT_LOCALE]!;
  return catalog[key] ?? catalogs[DEFAULT_LOCALE]![key];
}

export function errorMessage(errorCode: string, locale = activeLocale()): string {
  const key = `errors.${errorCode}` as MessageKey;
  const catalog = catalogs[locale] ?? catalogs[DEFAULT_LOCALE]!;
  return catalog[key] ?? catalogs[DEFAULT_LOCALE]![key] ?? errorCode;
}

export function formatDateTime(value: string, locale = activeLocale()): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
