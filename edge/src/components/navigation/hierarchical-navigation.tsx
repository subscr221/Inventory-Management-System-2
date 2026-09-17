'use client';

import { useState } from 'react';
import { t } from '../../i18n/locale';

interface NavItem {
  id: string;
  label: string;
  href?: string;
  icon?: string;
  children?: NavItem[];
  roleAccess?: string[];
}

// Maps a navigation item id to the name the bootstrap `navigation` allow-list uses.
const KNOWN_ALIASES: Record<string, string> = {
  dashboard: 'Dashboard',
  production: 'Frontline',
};

export function HierarchicalNavigation({ 
  currentRole,
  allowedItems,
}: { 
  currentRole: string;
  allowedItems?: string[];
}) {
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  
  // Navigation structure with hierarchical organization
  const navigationStructure: NavItem[] = [
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
        }
      ]
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
        }
      ]
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
        }
      ]
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
        }
      ]
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
        }
      ]
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
        }
      ]
    }
  ];

  const toggleExpand = (itemId: string) => {
    setExpandedItems(prev => ({
      ...prev,
      [itemId]: !prev[itemId]
    }));
  };

  const handleNavigation = (href?: string) => {
    if (!href) return;
    if (href.startsWith('#')) {
      window.location.hash = href;
    } else {
      window.location.assign(href);
    }
  };

  const renderNavItem = (item: NavItem, level = 0) => {
    // Check if user has access to this item
    if (item.roleAccess && !item.roleAccess.includes(currentRole)) {
      return null;
    }

    // Filter by the bootstrap-provided navigation allow-list, when one is present.
    if (allowedItems && allowedItems.length > 0) {
      const knownAlias = KNOWN_ALIASES[item.id];
      if (knownAlias && !allowedItems.includes(knownAlias)) {
        return null;
      }
    }

    const hasChildren = item.children && item.children.length > 0;
    const isExpanded = expandedItems[item.id] || false;

    return (
      <div 
        key={item.id} 
        className={`nav-item level-${level}`}
      >
        <div 
          className={`nav-item-header ${!hasChildren && item.href ? 'clickable' : ''}`}
          onClick={() => hasChildren ? toggleExpand(item.id) : handleNavigation(item.href)}
        >
          {item.icon && (
            <span className="nav-icon">
              {/* In a real implementation, this would be an actual icon component */}
              {item.icon}
            </span>
          )}
          <span className="nav-label">{item.label}</span>
          {hasChildren && (
            <span className={`nav-expand-icon ${isExpanded ? 'expanded' : ''}`}>
              ▼
            </span>
          )}
        </div>
        
        {hasChildren && isExpanded && (
          <div className="nav-children">
            {item.children?.map(child => renderNavItem(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <nav className="hierarchical-navigation" aria-label={t('nav.label')}>
      <div className="nav-header">
        <h2 className="nav-title">{t('nav.mainMenu')}</h2>
      </div>
      <div className="nav-items">
        {navigationStructure.map(item => renderNavItem(item))}
      </div>
    </nav>
  );
}