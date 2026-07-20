import messages from '../messages/en.json';

export type MessageKey = keyof typeof messages;

export function t(key: MessageKey): string {
  return messages[key];
}

export function errorMessage(errorCode: string): string {
  const key = `errors.${errorCode}` as MessageKey;
  return messages[key] ?? errorCode;
}

export function formatDateTime(value: string, locale = 'en-IN'): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}
