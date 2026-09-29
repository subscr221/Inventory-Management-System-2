import type { Metadata } from 'next';
import { DEFAULT_LOCALE, t } from '../src/i18n/locale';
// Lato is self-hosted (the edge is offline-first and the CSP allows only same-origin fonts).
import '@fontsource/lato/400.css';
import '@fontsource/lato/700.css';
import '@fontsource/lato/900.css';
import './globals.css';

export const metadata: Metadata = {
  title: t('app.title'),
  description: t('app.subtitle'),
  manifest: '/manifest.webmanifest',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang={DEFAULT_LOCALE}>
      <body>{children}</body>
    </html>
  );
}
