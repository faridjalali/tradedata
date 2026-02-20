import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/types.js';
import { DIVERGENCE_SOURCE_INTERVAL } from '../config.js';
import { toVolumeDeltaSourceInterval } from './chartEngine.js';
import { getPublishedTradeDateForSourceInterval } from './divergenceDbService.js';
import { currentEtDateString, dateKeyDaysAgo } from '../lib/dateUtils.js';
import { enrichRowsWithDivergenceData } from './alertEnrichment.js';

type SqlRowsResult = { rows: unknown[] };

export class AlertRouteService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly divergenceDb: Kysely<Database> | null,
    private readonly divergenceScanRunning: boolean,
  ) {}

  public isDivergenceConfigured(): boolean {
    return this.divergenceDb !== null;
  }

  public async getAlerts(
    queryOptions: { from?: string; to?: string; vd_source_interval?: string },
    limitValue: number = 500,
  ) {
    let rows: Array<Record<string, unknown>>;

    if (queryOptions.from || queryOptions.to) {
      let baseQuery = this.db.selectFrom('alerts').selectAll();

      if (queryOptions.from) {
        const fromDate = new Date(queryOptions.from);
        baseQuery = baseQuery.where('timestamp', '>=', fromDate);
      }
      if (queryOptions.to) {
        const toDate = new Date(queryOptions.to);
        baseQuery = baseQuery.where('timestamp', '<=', toDate);
      }

      // Add limit and sort to the query
      baseQuery = baseQuery.orderBy('timestamp', 'desc').limit(limitValue);
      rows = await baseQuery.execute();
    } else {
      rows = await this.db.selectFrom('alerts').selectAll().orderBy('timestamp', 'desc').limit(limitValue).execute();
    }

    if (rows.length === 0) return [];

    // Batch enrich rows with divergence data (which includes VDF data)
    const uniqueTickers = Array.from(
      new Set(
        rows.map((r) =>
          String(r?.ticker || '')
            .trim()
            .toUpperCase(),
        ),
      ),
    ).filter(Boolean);

    const sourceInterval = toVolumeDeltaSourceInterval(queryOptions.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
    return enrichRowsWithDivergenceData({
      rows,
      tickers: uniqueTickers,
      sourceInterval,
      contextLabel: 'GET /api/alerts',
    });
  }

  public async toggleAlertFavorite(id: number, isFavorite?: boolean) {
    const result =
      typeof isFavorite === 'boolean'
        ? await this.db.updateTable('alerts').set({ is_favorite: isFavorite }).where('id', '=', id).executeTakeFirst()
        : await this.db
            .updateTable('alerts')
            .set((eb) => ({ is_favorite: eb.not('is_favorite') }))
            .where('id', '=', id)
            .executeTakeFirst();

    if (Number(result.numUpdatedRows) === 0) {
      return null;
    }

    const updated = await this.db.selectFrom('alerts').select('is_favorite').where('id', '=', id).executeTakeFirst();
    return Boolean(updated?.is_favorite);
  }

  public async getDivergenceSignals(options: {
    days: number;
    startDate: string;
    endDate: string;
    hasDateKeyRange: boolean;
    timeframeParam?: string;
    vd_source_interval?: string;
  }) {
    if (!this.divergenceDb) throw new Error('Divergence database is not configured');

    const { days, startDate, endDate, hasDateKeyRange, timeframeParam } = options;
    const allowedTimeframes = timeframeParam === '1d' ? ['1d'] : timeframeParam === '1w' ? ['1w'] : ['1d', '1w'];
    const publishedTradeDate = await getPublishedTradeDateForSourceInterval(DIVERGENCE_SOURCE_INTERVAL);
    if (!publishedTradeDate && this.divergenceScanRunning) return [];

    const PER_TIMEFRAME_SIGNAL_LIMIT = 3029;
    let queryResult: SqlRowsResult;

    if (hasDateKeyRange) {
      queryResult = await sql`
      WITH filtered AS (
        SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
          ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
        FROM divergence_signals
        WHERE trade_date >= ${startDate}::date AND trade_date <= ${endDate}::date AND timeframe = ANY(${allowedTimeframes}::text[])
          AND (${publishedTradeDate || null}::date IS NULL OR trade_date <= ${publishedTradeDate || null}::date)
      )
      SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
        CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
        ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
      FROM filtered WHERE timeframe_rank <= ${PER_TIMEFRAME_SIGNAL_LIMIT} ORDER BY trade_date DESC, timestamp DESC`.execute(
        this.divergenceDb,
      );
    } else if (days > 0) {
      const lookbackDays = Math.max(1, Math.floor(Number(days) || 1));
      const endTradeDate = currentEtDateString();
      const startTradeDate = dateKeyDaysAgo(endTradeDate, lookbackDays - 1) || endTradeDate;
      queryResult = await sql`
      WITH filtered AS (
        SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
          ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
        FROM divergence_signals
        WHERE trade_date >= ${startTradeDate}::date AND trade_date <= ${endTradeDate}::date AND timeframe = ANY(${allowedTimeframes}::text[])
          AND (${publishedTradeDate || null}::date IS NULL OR trade_date <= ${publishedTradeDate || null}::date)
      )
      SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
        CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
        ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
      FROM filtered WHERE timeframe_rank <= ${PER_TIMEFRAME_SIGNAL_LIMIT} ORDER BY trade_date DESC, timestamp DESC`.execute(
        this.divergenceDb,
      );
    } else {
      queryResult = await sql`
      WITH filtered AS (
        SELECT id, ticker, signal_type, price, trade_date, timestamp, timeframe, volume_delta, is_favorite,
          ROW_NUMBER() OVER (PARTITION BY timeframe ORDER BY trade_date DESC, timestamp DESC) AS timeframe_rank
        FROM divergence_signals
        WHERE timeframe = ANY(${allowedTimeframes}::text[]) AND (${publishedTradeDate || null}::date IS NULL OR trade_date <= ${publishedTradeDate || null}::date)
      )
      SELECT id, ticker, signal_type, price, trade_date::text AS signal_trade_date, timestamp, timeframe,
        CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
        ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite
      FROM filtered WHERE timeframe_rank <= ${PER_TIMEFRAME_SIGNAL_LIMIT} ORDER BY trade_date DESC, timestamp DESC`.execute(
        this.divergenceDb,
      );
    }

    const rows = queryResult.rows as Array<Record<string, unknown>>;
    const sourceInterval = toVolumeDeltaSourceInterval(options.vd_source_interval, DIVERGENCE_SOURCE_INTERVAL);
    const tickers = Array.from(
      new Set(
        rows
          .map((row) =>
            String(row?.ticker || '')
              .trim()
              .toUpperCase(),
          )
          .filter(Boolean),
      ),
    ) as string[];

    return enrichRowsWithDivergenceData({
      rows: rows,
      tickers,
      sourceInterval,
      contextLabel: 'divergence signals',
    });
  }

  public async toggleDivergenceFavorite(id: number, isFavorite?: boolean) {
    if (!this.divergenceDb) throw new Error('Divergence database is not configured');

    let queryResult: SqlRowsResult;
    if (typeof isFavorite === 'boolean') {
      queryResult = await sql`UPDATE divergence_signals SET is_favorite = ${isFavorite} WHERE id = ${id}
      RETURNING id, ticker, signal_type, price, timestamp, timeframe,
        CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
        ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite`.execute(
        this.divergenceDb,
      );
    } else {
      queryResult = await sql`UPDATE divergence_signals SET is_favorite = NOT is_favorite WHERE id = ${id}
      RETURNING id, ticker, signal_type, price, timestamp, timeframe,
        CASE WHEN signal_type = 'bullish' THEN 1 ELSE -1 END AS signal_direction,
        ABS(volume_delta)::integer AS signal_volume, 0 AS intensity_score, 0 AS combo_score, is_favorite`.execute(
        this.divergenceDb,
      );
    }
    const rows = queryResult.rows;
    if (rows.length === 0) return null;
    return rows[0];
  }
}
