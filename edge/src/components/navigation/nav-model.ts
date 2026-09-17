import { t } from '../../i18n/locale';

export interface NavItem {
  id: string;
  label: string;
  href?: string;
  icon?: string;
  children?: NavItem[];
  roleAccess?: string[];
}

// Maps a navigation item id to the name the bootstrap `navigation` allow-list uses.
export const KNOWN_ALIASES: Record<string, string> = {
  dashboard: 'Dashboard',
  production: 'Frontline',
};

export function buildNavigationStructure(): NavItem[] {
  return [
    {
      id: 'dashboard',
      label: t('nav.dashboard'),
      href: '#dashboard',
      icon: 'dashboard',
    },
    {
      id: 'inventory',
      label: t('nav.inventory'),
      icon: 'inventory',
      children: [
        {
          id: 'stock-management',
          label: t('nav.stockManagement'),
          href: '#stock-management',
        },
        {
          id: 'cycle-counts',
          label: t('nav.cycleCounts'),
          href: '#cycle-counts',
        },
        {
          id: 'transfers',
          label: t('nav.transfers'),
          href: '#transfers',
        },
      ],
    },
    {
      id: 'procurement',
      label: t('nav.procurement'),
      icon: 'procurement',
      children: [
        {
          id: 'requisitions',
          label: t('nav.requisitions'),
          href: '#requisitions',
        },
        {
          id: 'suppliers',
          label: t('nav.suppliers'),
          href: '#suppliers',
        },
      ],
    },
    {
      id: 'production',
      label: t('nav.production'),
      icon: 'production',
      children: [
        {
          id: 'work-orders',
          label: t('nav.workOrders'),
          href: '/maintenance',
        },
        {
          id: 'bom',
          label: t('nav.bom'),
          href: '#bom',
        },
      ],
    },
    {
      id: 'quality',
      label: t('nav.quality'),
      icon: 'quality',
      children: [
        {
          id: 'inspections',
          label: t('nav.inspections'),
          href: '#inspections',
        },
        {
          id: 'non-conformances',
          label: t('nav.nonConformances'),
          href: '#non-conformances',
        },
      ],
    },
    {
      id: 'reports',
      label: t('nav.reports'),
      icon: 'reports',
      children: [
        {
          id: 'inventory-summary',
          label: t('nav.inventorySummary'),
          href: '/reports',
        },
        {
          id: 'movement-history',
          label: t('nav.movementHistory'),
          href: '/reports',
        },
      ],
    },
    {
      id: 'administration',
      label: t('nav.administration'),
      icon: 'administration',
      children: [
        {
          id: 'workflows',
          label: t('nav.workflows'),
          href: '/workflows',
        },
        {
          id: 'access-control',
          label: t('nav.accessControl'),
          href: '/access-control',
        },
      ],
    },
  ];
}
