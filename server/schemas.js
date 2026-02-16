const { z } = require('zod');

// --- Primitive schemas ---

const tickerSymbol = z.string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.\-]{0,19}$/, 'Invalid ticker format');

const etDate = z.string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine(val => {
    const dt = new Date(`${val}T00:00:00Z`);
    return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === val;
  }, 'Invalid calendar date');

const booleanInput = z.union([z.boolean(), z.number(), z.string()])
  .transform(val => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'number') return val !== 0;
    const normalized = String(val).trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    return false;
  });

const chartInterval = z.enum([
  '5min', '15min', '30min', '1hour', '4hour', '1day', '1week'
]);

// --- Scale time (unix seconds number OR date string) ---

const scaleTime = z.union([
  z.number().finite(),
  z.string().min(1)
]);

// --- Chart data point schemas ---

const candleLike = z.object({
  time: scaleTime,
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite()
});

const pointLike = z.object({
  time: scaleTime,
  value: z.number().finite()
});

const deltaPointLike = z.object({
  time: scaleTime,
  delta: z.number().finite()
});

// --- Chart payload validation schemas ---

const chartPayload = z.object({
  bars: z.array(candleLike).min(1, 'Chart payload bars are missing'),
  rsi: z.array(pointLike).default([]),
  volumeDelta: z.array(deltaPointLike).default([]),
  volumeDeltaRsi: z.object({
    rsi: z.array(pointLike).default([])
  }).optional()
}).passthrough();

const chartLatestPayload = z.object({
  latestBar: candleLike.nullable(),
  latestRsi: pointLike.nullish(),
  latestVolumeDeltaRsi: pointLike.nullish(),
  latestVolumeDelta: deltaPointLike.nullish()
}).passthrough();

// --- Query parameter schemas for routes ---

const chartQueryParams = z.object({
  ticker: tickerSymbol.default('SPY'),
  interval: chartInterval.default('4hour'),
  format: z.enum(['tuple', 'json']).optional(),
  vdRsiLength: z.coerce.number().int().min(1).max(200).default(14),
  vdSourceInterval: z.string().optional(),
  vdRsiSourceInterval: z.string().optional()
}).passthrough();

const tickerQueryParam = z.object({
  ticker: tickerSymbol
}).passthrough();

const tickerListQueryParams = z.object({
  ticker: z.string().optional(),
  tickers: z.string().optional()
}).passthrough();

const divergenceSummaryQueryParams = z.object({
  ticker: z.string().optional(),
  tickers: z.string().optional(),
  vdSourceInterval: z.string().default('1min'),
  refresh: z.string().optional(),
  nocache: z.string().optional(),
  noCache: z.string().optional()
}).passthrough();

const manualScanBody = z.object({
  force: booleanInput.optional().default(false),
  refreshUniverse: booleanInput.optional().default(false),
  runDateEt: etDate.optional()
}).passthrough();

module.exports = {
  tickerSymbol,
  etDate,
  booleanInput,
  chartInterval,
  scaleTime,
  candleLike,
  pointLike,
  deltaPointLike,
  chartPayload,
  chartLatestPayload,
  chartQueryParams,
  tickerQueryParam,
  tickerListQueryParams,
  divergenceSummaryQueryParams,
  manualScanBody
};
