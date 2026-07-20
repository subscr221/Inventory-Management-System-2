import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Inventory Edge Shell',
    short_name: 'Inventory Edge',
    description: 'Offline-first frontline edge shell for inventory capture',
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
