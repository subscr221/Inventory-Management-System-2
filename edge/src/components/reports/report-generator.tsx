'use client';

import { useState } from 'react';
import { t } from '../../i18n/locale';

interface ReportTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  lastGenerated?: string;
}

interface ReportData {
  id: string;
  name: string;
  generatedAt: string;
  format: 'pdf' | 'excel' | 'csv';
  size: string;
  createdBy: string;
}

export interface ReportParams {
  startDate?: string;
  endDate?: string;
  includeCharts?: boolean;
  format?: string;
}

interface ReportGeneratorProps {
  templates: ReportTemplate[];
  generatedReports: ReportData[];
  onGenerateReport: (templateId: string, params: ReportParams) => void;
  onDownloadReport: (reportId: string) => void;
  onDeleteReport: (reportId: string) => void;
}

export function ReportGenerator({ 
  templates, 
  generatedReports,
  onGenerateReport,
  onDownloadReport,
  onDeleteReport
}: ReportGeneratorProps) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [reportParams, setReportParams] = useState<ReportParams>({});
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState<'templates' | 'generated'>('templates');

  const selectedTemplate = templates.find(t => t.id === selectedTemplateId);

  const handleParamChange = (
    paramName: keyof ReportParams,
    value: ReportParams[keyof ReportParams],
  ) => {
    setReportParams(prev => ({
      ...prev,
      [paramName]: value
    }));
  };

  const handleGenerateReport = () => {
    if (selectedTemplateId) {
      setIsGenerating(true);
      onGenerateReport(selectedTemplateId, reportParams);
      // Simulate generation delay
      setTimeout(() => setIsGenerating(false), 2000);
    }
  };

  return (
    <div className="report-generator">
      <div className="report-header">
        <h2>{t('report.reporting')}</h2>
        <p>{t('report.generateAndManageReports')}</p>
      </div>

      <div className="report-tabs">
        <button 
          className={`tab ${activeTab === 'templates' ? 'active' : ''}`}
          onClick={() => setActiveTab('templates')}
        >
          {t('report.templates')}
        </button>
        <button 
          className={`tab ${activeTab === 'generated' ? 'active' : ''}`}
          onClick={() => setActiveTab('generated')}
        >
          {t('report.generatedReports')}
        </button>
      </div>

      {activeTab === 'templates' ? (
        <div className="report-templates-section">
          <div className="templates-list">
            <h3>{t('report.availableTemplates')}</h3>
            <div className="templates-grid">
              {templates.map(template => (
                <div 
                  key={template.id} 
                  className={`template-item ${selectedTemplateId === template.id ? 'selected' : ''}`}
                  onClick={() => setSelectedTemplateId(template.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedTemplateId(template.id);
                    }
                  }}
                  tabIndex={0}
                >
                  <div className="template-info">
                    <h4>{template.name}</h4>
                    <p>{template.description}</p>
                    <div className="template-meta">
                      <span className="template-category">{template.category}</span>
                      {template.lastGenerated && (
                        <span className="template-last-generated">
                          {t('report.lastGenerated')}: {new Date(template.lastGenerated).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {selectedTemplate && (
            <div className="template-details">
              <h3>{t('report.generateReport')}: {selectedTemplate.name}</h3>
              <div className="report-params">
                <div className="param-group">
                  <label htmlFor="date-range">{t('report.dateRange')}</label>
                  <div className="date-range-inputs">
                    <input
                      type="date"
                      id="startDate"
                      value={reportParams.startDate || ''}
                      onChange={(e) => handleParamChange('startDate', e.target.value)}
                    />
                    <span>{t('report.to')}</span>
                    <input
                      type="date"
                      id="endDate"
                      value={reportParams.endDate || ''}
                      onChange={(e) => handleParamChange('endDate', e.target.value)}
                    />
                  </div>
                </div>

                <div className="param-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={reportParams.includeCharts || false}
                      onChange={(e) => handleParamChange('includeCharts', e.target.checked)}
                    />
                    {t('report.includeCharts')}
                  </label>
                </div>

                <div className="param-group">
                  <label htmlFor="format">{t('report.outputFormat')}</label>
                  <select
                    id="format"
                    value={reportParams.format || 'pdf'}
                    onChange={(e) => handleParamChange('format', e.target.value)}
                  >
                    <option value="pdf">{t('report.formatPdf')}</option>
                    <option value="excel">{t('report.formatExcel')}</option>
                    <option value="csv">{t('report.formatCsv')}</option>
                  </select>
                </div>
              </div>

              <div className="generate-actions">
                <button 
                  className="primary-action"
                  onClick={handleGenerateReport}
                  disabled={isGenerating}
                >
                  {isGenerating ? t('report.generating') : t('report.generate')}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="generated-reports-section">
          <h3>{t('report.generatedReports')}</h3>
          {generatedReports.length === 0 ? (
            <div className="empty-state">
              <p>{t('report.noGeneratedReports')}</p>
            </div>
          ) : (
            <table className="reports-table">
              <thead>
                <tr>
                  <th scope="col">{t('report.reportName')}</th>
                  <th scope="col">{t('report.generatedAt')}</th>
                  <th scope="col">{t('report.format')}</th>
                  <th scope="col">{t('report.size')}</th>
                  <th scope="col">{t('report.createdBy')}</th>
                  <th scope="col">{t('report.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {generatedReports.map(report => (
                  <tr key={report.id}>
                    <th scope="row">{report.name}</th>
                    <td>{new Date(report.generatedAt).toLocaleDateString()}</td>
                    <td>{report.format.toUpperCase()}</td>
                    <td>{report.size}</td>
                    <td>{report.createdBy}</td>
                    <td className="actions-cell">
                      <button
                        className="secondary-action"
                        onClick={() => onDownloadReport(report.id)}
                      >
                        {t('report.download')}
                      </button>
                      <button
                        className="secondary-action danger"
                        onClick={() => onDeleteReport(report.id)}
                      >
                        {t('report.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}