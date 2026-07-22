import type { Metadata } from 'next';
import { DEFAULT_LOCALE, t } from '../src/i18n/locale';
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
