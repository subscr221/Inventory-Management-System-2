'use client';

import { useState } from 'react';
import { t } from '../../i18n/locale';
import { buildNavigationStructure, KNOWN_ALIASES, type NavItem } from './nav-model';

export function HierarchicalNavigation({ 
  currentRole,
  allowedItems,
}: { 
  currentRole: string;
  allowedItems?: string[];
}) {
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});

  const navigationStructure = buildNavigationStructure();

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
