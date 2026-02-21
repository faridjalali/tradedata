/**
 * Zod schemas for external Data API responses.
 *
 * These validate the shape of JSON payloads at the system boundary before
 * they propagate into the rest of the application, catching upstream API
 * contract changes early with clear diagnostics.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Aggregate bars  (v2/aggs/ticker/…)
// ---------------------------------------------------------------------------

/** A single OHLCV bar as returned by the aggregate endpoint. */
const AggBarSchema = z
  .object({
    t: z.number().optional(), // timestamp (ms epoch)
    o: z.number().optional(), // open
    h: z.number().optional(), // high
    l: z.number().optional(), // low
    c: z.number().optional(), // close
    v: z.number().optional(), // volume
    // Some endpoints return long-form keys:
    timestamp: z.number().optional(),
    time: z.number().optional(),
    open: z.number().optional(),
    high: z.number().optional(),
    low: z.number().optional(),
    close: z.number().optional(),
    price: z.number().optional(),
    volume: z.number().optional(),
  })
  .passthrough();

/** Top-level wrapper for aggregate-bars responses. */
export const AggregateResponseSchema = z.union([
  // Most common: { results: [...] }
  z.object({ results: z.array(AggBarSchema) }).passthrough(),
  // Alternate: { historical: [...] }
  z.object({ historical: z.array(AggBarSchema) }).passthrough(),
  // Raw array
  z.array(AggBarSchema),
]);

export type AggregateResponse = z.infer<typeof AggregateResponseSchema>;

// ---------------------------------------------------------------------------
// Indicator / MA value  (v1/indicators/…)
// ---------------------------------------------------------------------------

const IndicatorValueSchema = z
  .object({
    value: z.number().optional(),
    v: z.number().optional(),
    close: z.number().optional(),
    c: z.number().optional(),
  })
  .passthrough();

export const IndicatorResponseSchema = z
  .object({
    results: z
      .union([
        z.array(
          z
            .object({
              value: z.number().optional(),
              v: z.number().optional(),
              close: z.number().optional(),
              c: z.number().optional(),
              values: z.array(IndicatorValueSchema).optional(),
            })
            .passthrough(),
        ),
        z
          .object({
            values: z.array(IndicatorValueSchema),
          })
          .passthrough(),
      ])
      .optional(),
    values: z.array(IndicatorValueSchema).optional(),
  })
  .passthrough();

export type IndicatorResponse = z.infer<typeof IndicatorResponseSchema>;

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON payload against a Zod schema.
 * Returns the validated data on success, or `null` on failure (with a
 * console warning).  This is intentionally lenient — we log and degrade
 * rather than hard-crash, because upstream APIs may add fields at any time.
 */
export function validateApiResponse<T>(schema: z.ZodType<T>, payload: unknown, label: string): T | null {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  console.warn(`[Zod] ${label}: API response failed validation —`, result.error.issues.slice(0, 3));
  return null;
}
