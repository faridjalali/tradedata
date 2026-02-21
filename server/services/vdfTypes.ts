export interface Bar1m {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DailyAggregate {
  date: string;
  delta: number;
  totalVol: number;
  buyVol: number;
  sellVol: number;
  close: number;
  open: number;
  high: number;
  low: number;
}

export interface WeekAggregate {
  weekStart: string;
  delta: number;
  totalVol: number;
  deltaPct: number;
  nDays: number;
}

export interface DistributionCluster {
  start: number;
  end: number;
  startDate: string;
  endDate: string;
  count: number;
  maxPriceChg: number;
  minDeltaPct: number;
  spanDays?: number;
  priceChangePct?: number;
  netDelta?: number;
  netDeltaPct?: number;
}

export interface ProximitySignal {
  type: string;
  points: number;
  detail: string;
}

export interface ScoredZone {
  start: number;
  end: number;
  winSize: number;
  startDate: string;
  endDate: string;
  score: number;
  detected: boolean;
  reason: string;
  netDeltaPct: number;
  overallPriceChange: number;
  deltaSlopeNorm: number;
  accumWeekRatio: number;
  deltaShift: number;
  weeks: number;
  accumWeeks: number;
  absorptionPct: number;
  largeBuyVsSell: number;
  volDeclineScore: number;
  components: { s1: number; s2: number; s3: number; s4: number; s5: number; s6: number; s7: number; s8: number };
  durationMultiplier: number;
  concordancePenalty: number;
  intraRally: number;
  concordantFrac: number;
  cappedDays: Array<{ date: string; original: number; capped: number }>;
  rank?: number;
}

export interface FormattedZone {
  rank: number | undefined;
  startDate: string;
  endDate: string;
  windowDays: number;
  score: number;
  weeks: number;
  accumWeeks: number;
  netDeltaPct: number;
  absorptionPct: number;
  accumWeekRatio: number;
  overallPriceChange: number;
  components: { s1: number; s2: number; s3: number; s4: number; s5: number; s6: number; s7: number; s8: number };
  durationMultiplier: number;
  concordancePenalty: number;
  intraRally: number;
  concordantFrac: number;
}

export interface DetectVDFOptions {
  dataApiFetcher: (
    ticker: string,
    interval: string,
    days: number,
    opts: { signal?: AbortSignal },
  ) => Promise<Bar1m[] | null>;
  signal?: AbortSignal;
  mode?: 'scan' | 'chart';
}
