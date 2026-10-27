'use client';

import { useMemo, useState } from 'react';
import { t, type MessageKey } from '../../i18n/locale';

type LineStatus = 'available' | 'below-min' | 'in-transit' | 'on-hold';
type DeskFilter = 'all' | 'below-min' | 'in-transit' | 'on-hold';

interface StockLine {
  sku: string;
  nameKey: MessageKey;
  locationKey: MessageKey;
  uomKey: MessageKey;
  image: string;
  onHand: string;
  reserved: string;
  available: string;
  status: LineStatus;
}

const LINES: readonly StockLine[] = [
  {
    sku: 'MK-ALU-1201',
    nameKey: 'dashboard.item.aluminiumSheet',
    locationKey: 'dashboard.loc.binA14',
    uomKey: 'dashboard.uom.sheet',
    image: '/items/aluminium-sheet.jpg',
    onHand: '42',
    reserved: '6',
    available: '36',
    status: 'below-min',
  },
  {
    sku: 'MK-PNL-088',
    nameKey: 'dashboard.item.panelAssembly',
    locationKey: 'dashboard.loc.fgStore',
    uomKey: 'dashboard.uom.each',
    image: '/items/panel-assembly.jpg',
    onHand: '120',
    reserved: '18',
    available: '102',
    status: 'available',
  },
  {
    sku: 'MK-CST-014',
    nameKey: 'dashboard.item.customerCoil',
    locationKey: 'dashboard.loc.quarantine',
    uomKey: 'dashboard.uom.kg',
    image: '/items/customer-coil.jpg',
    onHand: '850',
    reserved: '850',
    available: '0',
    status: 'on-hold',
  },
  {
    sku: 'MK-TRF-4412',
    nameKey: 'dashboard.item.transferPlant',
    locationKey: 'dashboard.loc.inTransit',
    uomKey: 'dashboard.uom.each',
    image: '/items/transfer-plant.jpg',
    onHand: '24',
    reserved: '24',
    available: '0',
    status: 'in-transit',
  },
];

const FILTERS: readonly DeskFilter[] = ['all', 'below-min', 'in-transit', 'on-hold'];

function openingFilter(role: string): DeskFilter {
  if (role === 'warehouse-manager' || role === 'warehouse_admin') return 'below-min';
  if (role === 'procurement-specialist') return 'on-hold';
  if (role === 'logistics-coordinator') return 'in-transit';
  return 'all';
}

function filterLabel(filter: DeskFilter): string {
  switch (filter) {
    case 'all':
      return t('dashboard.tabAll');
    case 'below-min':
      return t('dashboard.tabBelowMin');
    case 'in-transit':
      return t('dashboard.tabInTransit');
    case 'on-hold':
      return t('dashboard.tabOnHold');
    default: {
      const neverFilter: never = filter;
      return neverFilter;
    }
  }
}

function statusLabel(status: LineStatus): string {
  switch (status) {
    case 'available':
      return t('dashboard.status.available');
    case 'below-min':
      return t('dashboard.status.belowMin');
    case 'in-transit':
      return t('dashboard.status.inTransit');
    case 'on-hold':
      return t('dashboard.status.onHold');
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}

export function EnhancedDashboard({
  role,
  pendingCount = 0,
  failedCount = 0,
}: {
  role: string;
  pendingCount?: number;
  failedCount?: number;
}) {
  const [filter, setFilter] = useState<DeskFilter>(() => openingFilter(role));
  const [query, setQuery] = useState('');
  const [selectedSku, setSelectedSku] = useState<string>(LINES[0]?.sku ?? '');

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return LINES.filter((line) => {
      if (filter !== 'all' && line.status !== filter) return false;
      if (!needle) return true;
      const name = t(line.nameKey).toLowerCase();
      return line.sku.toLowerCase().includes(needle) || name.includes(needle);
    });
  }, [filter, query]);

  const selected = visible.find((line) => line.sku === selectedSku) ?? visible[0] ?? null;

  const belowMin = LINES.filter((line) => line.status === 'below-min').length;
  const inTransit = LINES.filter((line) => line.status === 'in-transit').length;
  const onHold = LINES.filter((line) => line.status === 'on-hold').length;

  return (
    <section className="inventory-desk" aria-labelledby="inventory-desk-title">
      <header className="inventory-desk-header">
        <div>
          <h2 id="inventory-desk-title">{t('dashboard.title')}</h2>
          <p>{t('dashboard.welcomeMessage')}</p>
        </div>
        <a className="primary-action" href="/requisitions/new">
          {t('dashboard.newRequisition')}
        </a>
      </header>

      <div className="inventory-desk-metrics">
        <FilterMetric
          filter="below-min"
          active={filter}
          count={belowMin}
          label={t('dashboard.metricBelowMin')}
          onSelect={setFilter}
        />
        <FilterMetric
          filter="in-transit"
          active={filter}
          count={inTransit}
          label={t('dashboard.metricInTransit')}
          onSelect={setFilter}
        />
        <FilterMetric
          filter="on-hold"
          active={filter}
          count={onHold}
          label={t('dashboard.metricOnHold')}
          onSelect={setFilter}
        />
        <div className="inventory-desk-metric">
          <span className="inventory-desk-metric-value">{pendingCount}</span>
          <span className="inventory-desk-metric-label">{t('sync.pendingCount')}</span>
        </div>
        <div className="inventory-desk-metric">
          <span className="inventory-desk-metric-value">{failedCount}</span>
          <span className="inventory-desk-metric-label">{t('sync.failedCount')}</span>
        </div>
      </div>

      <div className="inventory-desk-toolbar">
        <div className="inventory-desk-tabs" role="tablist" aria-label={t('dashboard.title')}>
          {FILTERS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={filter === item}
              className={filter === item ? 'is-active' : undefined}
              onClick={() => setFilter(item)}
            >
              {filterLabel(item)}
            </button>
          ))}
        </div>
        <label className="inventory-desk-search">
          <span>{t('dashboard.searchLabel')}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('dashboard.searchPlaceholder')}
          />
        </label>
      </div>

      <div className="inventory-desk-split">
        {visible.length === 0 ? (
          <p className="inventory-desk-empty">{t('dashboard.empty')}</p>
        ) : (
          <table className="inventory-desk-table">
            <thead>
              <tr>
                <th scope="col">{t('dashboard.colSku')}</th>
                <th scope="col">{t('dashboard.colItem')}</th>
                <th scope="col">{t('dashboard.colOnHand')}</th>
                <th scope="col">{t('dashboard.colLocation')}</th>
                <th scope="col">{t('dashboard.colStatus')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((line) => {
                const isSelected = selected?.sku === line.sku;
                return (
                  <tr
                    key={line.sku}
                    className={isSelected ? 'is-selected' : undefined}
                    aria-selected={isSelected}
                    tabIndex={0}
                    onClick={() => setSelectedSku(line.sku)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') setSelectedSku(line.sku);
                    }}
                  >
                    <th scope="row">{line.sku}</th>
                    <td>{t(line.nameKey)}</td>
                    <td>
                      {line.onHand} {t(line.uomKey)}
                    </td>
                    <td>{t(line.locationKey)}</td>
                    <td>
                      <span className={`inventory-desk-pill is-${line.status}`}>
                        {statusLabel(line.status)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {selected ? (
          <aside className="inventory-desk-detail" aria-labelledby="inventory-desk-detail-title">
            <div className="inventory-desk-detail-head">
              <img
                className="inventory-desk-photo"
                src={selected.image}
                alt={t(selected.nameKey)}
                width={96}
                height={96}
              />
              <div>
                <p className="inventory-desk-sku">{selected.sku}</p>
                <h3 id="inventory-desk-detail-title">{t(selected.nameKey)}</h3>
                <p className={`inventory-desk-pill is-${selected.status}`}>{statusLabel(selected.status)}</p>
              </div>
            </div>
            <dl>
              <div>
                <dt>{t('dashboard.detailOnHand')}</dt>
                <dd>
                  {selected.onHand} {t(selected.uomKey)}
                </dd>
              </div>
              <div>
                <dt>{t('dashboard.detailReserved')}</dt>
                <dd>
                  {selected.reserved} {t(selected.uomKey)}
                </dd>
              </div>
              <div>
                <dt>{t('dashboard.detailAvailable')}</dt>
                <dd>
                  {selected.available} {t(selected.uomKey)}
                </dd>
              </div>
              <div>
                <dt>{t('dashboard.colLocation')}</dt>
                <dd>{t(selected.locationKey)}</dd>
              </div>
            </dl>
            <a className="secondary-action" href="/stock">
              {t('dashboard.checkStock')}
            </a>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function FilterMetric({
  filter,
  active,
  count,
  label,
  onSelect,
}: {
  filter: Exclude<DeskFilter, 'all'>;
  active: DeskFilter;
  count: number;
  label: string;
  onSelect: (filter: DeskFilter) => void;
}) {
  return (
    <button
      type="button"
      className={active === filter ? 'inventory-desk-metric is-active' : 'inventory-desk-metric'}
      onClick={() => onSelect(filter)}
    >
      <span className="inventory-desk-metric-value">{count}</span>
      <span className="inventory-desk-metric-label">{label}</span>
    </button>
  );
}
