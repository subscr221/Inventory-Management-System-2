import type { MetadataRoute } from 'next';
import { t } from '../src/i18n/locale';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: t('app.title'),
    short_name: t('app.shortTitle'),
    description: t('app.subtitle'),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f8f9fa',
    theme_color: '#1f47d9',
    icons: [
      {
        src: '/icons/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}
