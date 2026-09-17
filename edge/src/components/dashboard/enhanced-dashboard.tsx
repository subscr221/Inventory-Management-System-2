'use client';

import { useState } from 'react';
import type { ChartData } from 'chart.js';
import { ChartComponent } from './chart-component';
import { AdvancedFilter, type AppliedFilter } from '../filters/advanced-filter';
import { t } from '../../i18n/locale';

interface KPIData {
  value: string | number;
  label: string;
  trend?: 'up' | 'down' | 'neutral';
  change?: string;
}

interface ActivityItem {
  id: number;
  action: string;
  user: string;
  time: string;
}

type WidgetData = KPIData | ChartData<'bar' | 'line' | 'pie'> | ActivityItem[];

interface DashboardWidget {
  id: string;
  title: string;
  type: 'kpi' | 'chart' | 'list';
  data: WidgetData;
  position: { x: number; y: number };
  size: { width: number; height: number };
  chartType?: 'bar' | 'line' | 'pie';
}

interface FilterOption {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'checkbox';
  options?: Array<{ value: string; label: string }>;
}

const ACTIVITY_ITEMS: ActivityItem[] = [
  { id: 1, action: 'Cross-dock task completed', user: 'John Doe', time: '2 min ago' },
  { id: 2, action: 'New indent raised', user: 'Jane Smith', time: '15 min ago' },
  { id: 3, action: 'Maintenance WO updated', user: 'Bob Johnson', time: '1 hour ago' },
];

export function EnhancedDashboard({
  userName,
  role,
  pendingCount = 0,
  failedCount = 0,
}: {
  userName: string;
  role: string;
  pendingCount?: number;
  failedCount?: number;
}) {
  const [widgets, setWidgets] = useState<DashboardWidget[]>([
    {
      id: 'inventory-levels',
      title: t('dashboard.inventoryLevels'),
      type: 'kpi',
      data: { value: '87%', label: 'Storage Utilization', trend: 'up', change: '+2%' } as KPIData,
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
    },
    {
      id: 'inventory-trend',
      title: t('dashboard.inventoryTrend'),
      type: 'chart',
      chartType: 'line',
      data: {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
        datasets: [
          {
            label: 'Inventory Level',
            data: [65, 72, 70, 78, 82, 87],
            borderColor: 'rgb(255, 99, 132)',
            backgroundColor: 'rgba(255, 99, 132, 0.5)',
          },
        ],
      },
      position: { x: 1, y: 0 },
      size: { width: 1, height: 1 },
    },
    {
      id: 'recent-activity',
      title: t('dashboard.recentActivity'),
      type: 'list',
      data: ACTIVITY_ITEMS,
      position: { x: 0, y: 1 },
      size: { width: 2, height: 1 },
    },
  ]);

  const [roleView, setRoleView] = useState(role);
  const [activeFilters, setActiveFilters] = useState<AppliedFilter[]>([]);

  const filterOptions: FilterOption[] = [
    {
      id: 'date-range',
      label: t('filter.dateRange'),
      type: 'date',
    },
    {
      id: 'status',
      label: t('filter.status'),
      type: 'select',
      options: [
        { value: 'all', label: t('filter.allStatuses') },
        { value: 'pending', label: t('filter.pending') },
        { value: 'completed', label: t('filter.completed') },
        { value: 'in-progress', label: t('filter.inProgress') },
      ],
    },
    {
      id: 'category',
      label: t('filter.category'),
      type: 'select',
      options: [
        { value: 'all', label: t('filter.allCategories') },
        { value: 'raw-materials', label: t('filter.rawMaterials') },
        { value: 'finished-goods', label: t('filter.finishedGoods') },
        { value: 'work-in-progress', label: t('filter.workInProgress') },
      ],
    },
    {
      id: 'location',
      label: t('filter.location'),
      type: 'text',
    },
  ];

  const handleDragStart = (e: React.DragEvent, widgetId: string) => {
    e.dataTransfer.setData('widgetId', widgetId);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, newPosition: { x: number; y: number }) => {
    e.preventDefault();
    const widgetId = e.dataTransfer.getData('widgetId');

    setWidgets((prev) =>
      prev.map((widget) =>
        widget.id === widgetId ? { ...widget, position: newPosition } : widget,
      ),
    );
  };

  const handleApplyFilters = (appliedFilters: AppliedFilter[]) => {
    setActiveFilters(appliedFilters);
  };

  const handleResetFilters = () => {
    setActiveFilters([]);
  };

  const renderKPIWidget = (widget: DashboardWidget) => {
    const data = widget.data as KPIData;
    return (
      <div className="dashboard-widget kpi-widget">
        <h3>{widget.title}</h3>
        <div className="kpi-content">
          <span className="kpi-value">{data.value}</span>
          <span className="kpi-label">{data.label}</span>
          {data.trend ? (
            <span className={`kpi-trend ${data.trend}`}>{data.change}</span>
          ) : null}
        </div>
      </div>
    );
  };

  const renderChartWidget = (widget: DashboardWidget) => {
    return (
      <div className="dashboard-widget chart-widget">
        <ChartComponent
          type={widget.chartType ?? 'bar'}
          data={widget.data as ChartData<'bar' | 'line' | 'pie'>}
          title={widget.title}
        />
      </div>
    );
  };

  const renderListWidget = (widget: DashboardWidget) => {
    const items = widget.data as ActivityItem[];
    return (
      <div className="dashboard-widget list-widget">
        <h3>{widget.title}</h3>
        <ul className="activity-list">
          {items.map((item) => (
            <li key={item.id} className="activity-item">
              <span className="activity-action">{item.action}</span>
              <span className="activity-user">by {item.user}</span>
              <span className="activity-time">{item.time}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  };

  const renderWidget = (widget: DashboardWidget) => {
    switch (widget.type) {
      case 'kpi':
        return renderKPIWidget(widget);
      case 'chart':
        return renderChartWidget(widget);
      case 'list':
        return renderListWidget(widget);
    }
  };

  return (
    <div className="enhanced-dashboard">
      <div className="dashboard-controls">
        <div className="view-selector">
          <label htmlFor="role-view">{t('dashboard.viewByRole')}</label>
          <select
            id="role-view"
            value={roleView}
            onChange={(e) => setRoleView(e.target.value)}
          >
            <option value="warehouse-manager">{t('roles.warehouseManager')}</option>
            <option value="procurement-specialist">{t('roles.procurementSpecialist')}</option>
            <option value="logistics-coordinator">{t('roles.logisticsCoordinator')}</option>
          </select>
        </div>

        <div className="dashboard-header">
          <h2>{t('dashboard.title')}</h2>
          <p>{t('dashboard.welcomeMessage').replace('{userName}', userName)}</p>
        </div>
      </div>

      <AdvancedFilter
        filterOptions={filterOptions}
        onApplyFilters={handleApplyFilters}
        onResetFilters={handleResetFilters}
      />

      <div className="sync-counts" aria-live="polite">
        <div>
          <dt>{t('sync.pendingCount')}</dt>
          <dd>{pendingCount}</dd>
        </div>
        <div>
          <dt>{t('sync.failedCount')}</dt>
          <dd>{failedCount}</dd>
        </div>
        {activeFilters.length > 0 ? (
          <div>
            <dt>{t('dashboard.activeFilters')}</dt>
            <dd>{activeFilters.length}</dd>
          </div>
        ) : null}
      </div>

      <div className="dashboard-grid">
        {widgets
          .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
          .map((widget) => (
            <div
              key={widget.id}
              className={`dashboard-grid-item size-${widget.size.width}x${widget.size.height}`}
              style={{
                gridColumn: `${widget.position.x + 1} / span ${widget.size.width}`,
                gridRow: `${widget.position.y + 1} / span ${widget.size.height}`,
              }}
              draggable
              onDragStart={(e) => handleDragStart(e, widget.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, widget.position)}
            >
              {renderWidget(widget)}
            </div>
          ))}
      </div>
    </div>
  );
}
