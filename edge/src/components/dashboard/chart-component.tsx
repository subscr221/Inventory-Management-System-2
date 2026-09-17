'use client';

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
} from 'chart.js';
import type { ChartData, ChartOptions } from 'chart.js';
import { Bar, Line, Pie } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
);

interface ChartComponentProps {
  type: 'bar' | 'line' | 'pie';
  data: ChartData<'bar' | 'line' | 'pie'>;
  options?: ChartOptions<'bar' | 'line' | 'pie'>;
  title: string;
}

export function ChartComponent({ type, data, options, title }: ChartComponentProps) {
  const defaultOptions: ChartOptions<'bar' | 'line' | 'pie'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top' as const,
      },
      title: {
        display: true,
        text: title,
      },
    },
  };

  const mergedOptions = {
    ...defaultOptions,
    ...options,
  };

  if (type === 'line') {
    return (
      <div className="chart-container">
        <Line
          data={data as ChartData<'line'>}
          options={mergedOptions as ChartOptions<'line'>}
        />
      </div>
    );
  }

  if (type === 'pie') {
    return (
      <div className="chart-container">
        <Pie
          data={data as ChartData<'pie'>}
          options={mergedOptions as ChartOptions<'pie'>}
        />
      </div>
    );
  }

  return (
    <div className="chart-container">
      <Bar
        data={data as ChartData<'bar'>}
        options={mergedOptions as ChartOptions<'bar'>}
      />
    </div>
  );
}
