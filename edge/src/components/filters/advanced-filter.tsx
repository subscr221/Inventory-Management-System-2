'use client';

import { useState } from 'react';
import { t } from '../../i18n/locale';

interface FilterOption {
  id: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'checkbox';
  options?: Array<{ value: string; label: string }>;
}

type FilterValue = string | boolean;

export interface AppliedFilter {
  id: string;
  value: FilterValue;
  label: string;
}

interface AdvancedFilterProps {
  filterOptions: FilterOption[];
  onApplyFilters: (filters: AppliedFilter[]) => void;
  onResetFilters: () => void;
}

export function AdvancedFilter({ 
  filterOptions, 
  onApplyFilters, 
  onResetFilters 
}: AdvancedFilterProps) {
  const [activeFilters, setActiveFilters] = useState<Record<string, FilterValue>>({});
  const [savedFilters, setSavedFilters] = useState<Array<{name: string; filters: AppliedFilter[]}>>([]);
  const [showSavedFilters, setShowSavedFilters] = useState(false);

  const handleFilterChange = (filterId: string, value: FilterValue) => {
    setActiveFilters(prev => ({
      ...prev,
      [filterId]: value
    }));
  };

  const applyFilters = () => {
    const appliedFilters: AppliedFilter[] = [];
    
    filterOptions.forEach(option => {
      const value = activeFilters[option.id];
      if (value !== undefined && value !== '') {
        appliedFilters.push({
          id: option.id,
          value,
          label: option.label
        });
      }
    });
    
    onApplyFilters(appliedFilters);
  };

  const resetFilters = () => {
    setActiveFilters({});
    onResetFilters();
  };

  const saveCurrentFilters = () => {
    const filterName = prompt(t('filter.enterNameForFilters'));
    if (filterName) {
      const appliedFilters: AppliedFilter[] = [];
      
      filterOptions.forEach(option => {
        const value = activeFilters[option.id];
        if (value !== undefined && value !== '') {
          appliedFilters.push({
            id: option.id,
            value,
            label: option.label
          });
        }
      });
      
      setSavedFilters(prev => [
        ...prev,
        { name: filterName, filters: appliedFilters }
      ]);
    }
  };

  const loadSavedFilter = (filters: AppliedFilter[]) => {
    const newActiveFilters: Record<string, FilterValue> = {};
    filters.forEach(filter => {
      newActiveFilters[filter.id] = filter.value;
    });
    setActiveFilters(newActiveFilters);
    onApplyFilters(filters);
    setShowSavedFilters(false);
  };

  const removeSavedFilter = (index: number) => {
    setSavedFilters(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="advanced-filter">
      <div className="filter-header">
        <h3>{t('filter.advancedFiltering')}</h3>
        <div className="filter-actions">
          <button 
            className="secondary-action"
            onClick={() => setShowSavedFilters(!showSavedFilters)}
          >
            {showSavedFilters ? t('filter.hideSaved') : t('filter.showSaved')}
          </button>
          <button 
            className="secondary-action"
            onClick={saveCurrentFilters}
            disabled={Object.keys(activeFilters).length === 0}
          >
            {t('filter.saveCurrent')}
          </button>
        </div>
      </div>

      {showSavedFilters && (
        <div className="saved-filters">
          <h4>{t('filter.savedFilters')}</h4>
          {savedFilters.length === 0 ? (
            <p>{t('filter.noSavedFilters')}</p>
          ) : (
            <ul className="saved-filters-list">
              {savedFilters.map((savedFilter, index) => (
                <li key={index} className="saved-filter-item">
                  <span className="saved-filter-name">{savedFilter.name}</span>
                  <div className="saved-filter-actions">
                    <button 
                      className="secondary-action small"
                      onClick={() => loadSavedFilter(savedFilter.filters)}
                    >
                      {t('filter.load')}
                    </button>
                    <button 
                      className="secondary-action small"
                      onClick={() => removeSavedFilter(index)}
                    >
                      {t('filter.remove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="filter-options">
        {filterOptions.map(option => (
          <div key={option.id} className="filter-option">
            <label htmlFor={option.id}>{option.label}</label>
            {option.type === 'text' && (
              <input
                type="text"
                id={option.id}
                value={String(activeFilters[option.id] ?? '')}
                onChange={(e) => handleFilterChange(option.id, e.target.value)}
              />
            )}
            {option.type === 'number' && (
              <input
                type="number"
                id={option.id}
                value={String(activeFilters[option.id] ?? '')}
                onChange={(e) => handleFilterChange(option.id, e.target.value)}
              />
            )}
            {option.type === 'date' && (
              <input
                type="date"
                id={option.id}
                value={String(activeFilters[option.id] ?? '')}
                onChange={(e) => handleFilterChange(option.id, e.target.value)}
              />
            )}
            {option.type === 'select' && option.options && (
              <select
                id={option.id}
                value={String(activeFilters[option.id] ?? '')}
                onChange={(e) => handleFilterChange(option.id, e.target.value)}
              >
                <option value="">{t('filter.selectOption')}</option>
                {option.options.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}
            {option.type === 'checkbox' && (
              <input
                type="checkbox"
                id={option.id}
                checked={Boolean(activeFilters[option.id])}
                onChange={(e) => handleFilterChange(option.id, e.target.checked)}
              />
            )}
          </div>
        ))}
      </div>

      <div className="filter-buttons">
        <button 
          className="primary-action"
          onClick={applyFilters}
        >
          {t('filter.applyFilters')}
        </button>
        <button 
          className="secondary-action"
          onClick={resetFilters}
        >
          {t('filter.resetFilters')}
        </button>
      </div>
    </div>
  );
}