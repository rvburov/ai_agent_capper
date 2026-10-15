// Графики этапа 4 (mockup/js/ui.js: lineChart, columnChart, hbars, calibrationChart, sparkline,
// legend, withTable) — свой SVG без библиотеки: цвета из токенов, подсказка с клавиатуры,
// таблица-двойник. Экраны берут их отсюда; в начальную загрузку они не попадают.
export { CalibrationChart, type CalibrationBin, type CalibrationChartProps } from './CalibrationChart';
export { ChartLegend, type LegendItem } from './ChartLegend';
export { ChartTooltip, tooltipText, type ChartTooltipProps, type TooltipRow } from './ChartTooltip';
export { ChartWithTable, type ChartWithTableProps } from './ChartWithTable';
export { ColumnChart, type ColumnChartProps, type ColumnItem } from './ColumnChart';
export { HBars, type HBarItem, type HBarsProps } from './HBars';
export { LineChart, type ChartMark, type LineChartProps, type LineSeries, type RefLine } from './LineChart';
export { Sparkline, type SparklineProps } from './Sparkline';
export { CHART_COLORS, CHART_MUTED } from './colors';
export { defaultValueFormat } from './defaultFormat';
export type { AxisTick, ValueFormat } from './geometry';
