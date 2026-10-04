'use client';

import { useState } from 'react';
import { ReportGenerator } from '../reports/report-generator';
import { MOCK_REPORT_TEMPLATES, MOCK_REPORTS, type ReportData } from './mock-data';
import type { ReportParams } from '../reports/report-generator';

export function ReportsView({ currentUserName }: { currentUserName: string }) {
  const [reports, setReports] = useState<ReportData[]>(MOCK_REPORTS);

  const generateReport = (templateId: string, params: ReportParams) => {
    const template = MOCK_REPORT_TEMPLATES.find((t) => t.id === templateId);
    if (!template) return;
    const format = (params.format as ReportData['format']) ?? 'pdf';
    const now = new Date().toISOString();
    setReports((prev) => [
      {
        id: `rep.${Date.now()}`,
        name: template.name,
        generatedAt: now,
        format,
        size: '0 KB',
        createdBy: currentUserName,
      },
      ...prev,
    ]);
  };

  const deleteReport = (reportId: string) => {
    setReports((prev) => prev.filter((report) => report.id !== reportId));
  };

  return (
    <ReportGenerator
      templates={MOCK_REPORT_TEMPLATES}
      generatedReports={reports}
      onGenerateReport={generateReport}
      onDownloadReport={() => undefined}
      onDeleteReport={deleteReport}
    />
  );
}
