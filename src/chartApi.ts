// Chart API types and client

export type ChartInterval = '1hour' | '2hour' | '4hour' | '1day';
export type RSIDisplayMode = 'line' | 'points';

export interface CandleBar {
  time: string; // LA timezone: "YYYY-MM-DD" for daily, "YYYY-MM-DD HH:MM" for intraday
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RSIPoint {
  time: string;
  value: number;
}

export interface ChartData {
  interval: ChartInterval;
  timezone: 'America/Los_Angeles';
  bars: CandleBar[];
  rsi: RSIPoint[];

}

export async function fetchChartData(ticker: string, interval: ChartInterval): Promise<ChartData> {
  const url = `/api/chart?ticker=${encodeURIComponent(ticker)}&interval=${interval}`;
  const response = await fetch(url);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Failed to fetch chart data' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// Aggregate 1-hour bars into 2-hour bars (client-side)
export function aggregate2HourBars(hourlyBars: CandleBar[]): CandleBar[] {
  const twoHourBars: CandleBar[] = [];

  for (let i = 0; i < hourlyBars.length; i += 2) {
    if (i + 1 < hourlyBars.length) {
      twoHourBars.push({
        time: hourlyBars[i].time,  // Use first bar's time
        open: hourlyBars[i].open,
        high: Math.max(hourlyBars[i].high, hourlyBars[i + 1].high),
        low: Math.min(hourlyBars[i].low, hourlyBars[i + 1].low),
        close: hourlyBars[i + 1].close,  // Use second bar's close
        volume: hourlyBars[i].volume + hourlyBars[i + 1].volume
      });
    } else {
      // If odd number of bars, include the last one as-is
      twoHourBars.push(hourlyBars[i]);
    }
  }

  return twoHourBars;
}

// Aggregate RSI data to match 2-hour bars (take every other point)
export function aggregate2HourRSI(hourlyRSI: RSIPoint[]): RSIPoint[] {
  const twoHourRSI: RSIPoint[] = [];

  for (let i = 0; i < hourlyRSI.length; i += 2) {
    // Use the second bar's RSI value (the closing value of the 2-hour period)
    if (i + 1 < hourlyRSI.length) {
      twoHourRSI.push({
        time: hourlyRSI[i].time,  // Use first bar's time to match aggregated bars
        value: hourlyRSI[i + 1].value  // Use second bar's RSI (closing RSI of 2hr period)
      });
    } else {
      // If odd number, include the last one as-is
      twoHourRSI.push(hourlyRSI[i]);
    }
  }

  return twoHourRSI;
}
