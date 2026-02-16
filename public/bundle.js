"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/state.ts
  var allAlerts = [];
  function getAlerts() {
    return allAlerts;
  }

  // src/divergenceState.ts
  var allDivergenceSignals = [];
  function getDivergenceSignals() {
    return allDivergenceSignals;
  }
  function setDivergenceSignals(signals) {
    allDivergenceSignals = signals;
  }
  function setDivergenceSignalsByTimeframe(timeframe, signals) {
    const kept = allDivergenceSignals.filter((a2) => (a2.timeframe || "").trim() !== timeframe);
    allDivergenceSignals = [...kept, ...signals];
  }

  // src/timezone.ts
  var APP_TIMEZONE_STORAGE_KEY = "catvue_app_timezone_v1";
  var DEFAULT_APP_TIME_ZONE = "America/Los_Angeles";
  var APP_TIMEZONE_OPTIONS = [
    { value: "America/Los_Angeles", label: "Los Angeles (US Pacific time)" },
    { value: "America/Denver", label: "Denver (US Mountain time)" },
    { value: "America/Chicago", label: "Chicago (US Central time)" },
    { value: "America/New_York", label: "New York (US Eastern time)" },
    { value: "UTC", label: "UTC" }
  ];
  var APP_TIMEZONE_VALUES = new Set(APP_TIMEZONE_OPTIONS.map((option) => option.value));
  var listeners = /* @__PURE__ */ new Set();
  var currentAppTimeZone = resolveInitialTimeZone();
  var formatterCacheTimeZone = currentAppTimeZone;
  var formatterCache = /* @__PURE__ */ new Map();
  function isSupportedTimeZone(value) {
    if (!value) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }
  function normalizeAppTimeZone(value) {
    const candidate = String(value || "").trim();
    if (!candidate) return DEFAULT_APP_TIME_ZONE;
    if (!APP_TIMEZONE_VALUES.has(candidate)) return DEFAULT_APP_TIME_ZONE;
    if (!isSupportedTimeZone(candidate)) return DEFAULT_APP_TIME_ZONE;
    return candidate;
  }
  function resolveInitialTimeZone() {
    let stored = "";
    try {
      stored = typeof window !== "undefined" ? String(window.localStorage.getItem(APP_TIMEZONE_STORAGE_KEY) || "") : "";
    } catch {
      stored = "";
    }
    return normalizeAppTimeZone(stored);
  }
  function persistTimeZone(value) {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(APP_TIMEZONE_STORAGE_KEY, value);
    } catch {
    }
  }
  function buildFormatterCacheKey(locale, options) {
    const localeKey = Array.isArray(locale) ? locale.join("|") : locale;
    const entries = Object.entries(options).sort(([a2], [b2]) => a2.localeCompare(b2)).map(([key, value]) => `${key}:${String(value)}`);
    return `${localeKey}|${entries.join(",")}`;
  }
  function getAppTimeZoneOptions() {
    return APP_TIMEZONE_OPTIONS.map((option) => ({ ...option }));
  }
  function getAppTimeZone() {
    return currentAppTimeZone;
  }
  function getAppTimeZoneFormatter(locale = "en-US", options = {}) {
    const activeTimeZone = getAppTimeZone();
    if (formatterCacheTimeZone !== activeTimeZone) {
      formatterCache.clear();
      formatterCacheTimeZone = activeTimeZone;
    }
    const cacheKey = buildFormatterCacheKey(locale, options);
    const cached = formatterCache.get(cacheKey);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: activeTimeZone
    });
    formatterCache.set(cacheKey, formatter);
    return formatter;
  }
  function setAppTimeZone(value) {
    const nextTimeZone = normalizeAppTimeZone(value);
    const previousTimeZone = currentAppTimeZone;
    if (nextTimeZone === previousTimeZone) return nextTimeZone;
    currentAppTimeZone = nextTimeZone;
    persistTimeZone(nextTimeZone);
    formatterCache.clear();
    formatterCacheTimeZone = nextTimeZone;
    listeners.forEach((listener) => {
      try {
        listener(nextTimeZone, previousTimeZone);
      } catch {
      }
    });
    return nextTimeZone;
  }
  function onAppTimeZoneChange(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  // src/divergenceTable.ts
  var DIVERGENCE_LOOKBACK_DAYS = [1, 3, 7, 14, 28];
  var divergenceSummaryCache = /* @__PURE__ */ new Map();
  var divergenceSummaryBatchInFlight = /* @__PURE__ */ new Map();
  var CHART_SETTINGS_STORAGE_KEY = "custom_chart_settings_v1";
  var DEFAULT_DIVERGENCE_SOURCE_INTERVAL = "1min";
  var VALID_DIVERGENCE_SOURCE_INTERVALS = /* @__PURE__ */ new Set(["1min", "5min", "15min", "30min", "1hour", "4hour"]);
  function normalizeState(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (value === "bullish" || value === "bearish") return value;
    return "neutral";
  }
  function normalizeTicker(value) {
    return String(value || "").trim().toUpperCase();
  }
  function normalizeSourceInterval(raw) {
    const value = String(raw || "").trim();
    return VALID_DIVERGENCE_SOURCE_INTERVALS.has(value) ? value : DEFAULT_DIVERGENCE_SOURCE_INTERVAL;
  }
  function getPreferredDivergenceSourceInterval() {
    try {
      if (typeof window === "undefined") return DEFAULT_DIVERGENCE_SOURCE_INTERVAL;
      const raw = window.localStorage.getItem(CHART_SETTINGS_STORAGE_KEY);
      if (!raw) return DEFAULT_DIVERGENCE_SOURCE_INTERVAL;
      const parsed = JSON.parse(raw);
      return normalizeSourceInterval(parsed?.volumeDelta?.sourceInterval);
    } catch {
      return DEFAULT_DIVERGENCE_SOURCE_INTERVAL;
    }
  }
  function cacheKeyFor(ticker, sourceInterval) {
    return `${normalizeTicker(ticker)}|${normalizeSourceInterval(sourceInterval)}`;
  }
  function getCachedSummary(ticker, sourceInterval) {
    const key = cacheKeyFor(ticker, sourceInterval);
    const cached = divergenceSummaryCache.get(key);
    if (!cached) return null;
    if (!Number.isFinite(cached.expiresAtMs) || cached.expiresAtMs <= Date.now()) {
      divergenceSummaryCache.delete(key);
      return null;
    }
    return cached;
  }
  function setCachedSummary(sourceInterval, entry) {
    const key = cacheKeyFor(entry.ticker, sourceInterval);
    divergenceSummaryCache.set(key, entry);
  }
  function buildNeutralStates() {
    const out = {};
    for (const days of DIVERGENCE_LOOKBACK_DAYS) {
      out[String(days)] = "neutral";
    }
    return out;
  }
  function normalizeApiSummary(item) {
    const ticker = normalizeTicker(item?.ticker);
    if (!ticker) return null;
    const states = buildNeutralStates();
    const rawStates = item?.states || {};
    for (const days of DIVERGENCE_LOOKBACK_DAYS) {
      states[String(days)] = normalizeState(rawStates[String(days)]);
    }
    const expiresAtMs = Number(item?.expiresAtMs);
    const safeExpiresAt = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() ? expiresAtMs : Date.now() + 60 * 60 * 1e3;
    return {
      ticker,
      tradeDate: typeof item?.tradeDate === "string" ? item.tradeDate : null,
      states,
      expiresAtMs: safeExpiresAt
    };
  }
  async function fetchDivergenceSummariesBatch(tickers, sourceInterval, options) {
    const normalizedSourceInterval = normalizeSourceInterval(sourceInterval);
    const forceRefresh = options?.forceRefresh === true;
    const noCache = options?.noCache === true;
    const uniqueTickers = Array.from(new Set(
      tickers.map((ticker) => normalizeTicker(ticker)).filter(Boolean)
    ));
    if (uniqueTickers.length === 0) return /* @__PURE__ */ new Map();
    const requestKey = `${normalizedSourceInterval}|${forceRefresh ? "refresh" : "cached"}|${noCache ? "nocache" : "cache"}|${uniqueTickers.join(",")}`;
    if (divergenceSummaryBatchInFlight.has(requestKey)) {
      return await divergenceSummaryBatchInFlight.get(requestKey);
    }
    const batchPromise = (async () => {
      const resolved = /* @__PURE__ */ new Map();
      const params = new URLSearchParams();
      params.set("tickers", uniqueTickers.join(","));
      params.set("vdSourceInterval", normalizedSourceInterval);
      if (forceRefresh) {
        params.set("refresh", "1");
      }
      if (noCache) {
        params.set("nocache", "1");
      }
      const response = await fetch(`/api/chart/divergence-summary?${params.toString()}`, {
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch divergence summary (HTTP ${response.status})`);
      }
      const payload = await response.json();
      const rows = Array.isArray(payload?.summaries) ? payload.summaries : [];
      for (const row of rows) {
        const normalized = normalizeApiSummary(row);
        if (!normalized) continue;
        resolved.set(normalized.ticker, normalized);
        setCachedSummary(normalizedSourceInterval, normalized);
      }
      return resolved;
    })().catch(() => {
      return /* @__PURE__ */ new Map();
    }).finally(() => {
      divergenceSummaryBatchInFlight.delete(requestKey);
    });
    divergenceSummaryBatchInFlight.set(requestKey, batchPromise);
    return await batchPromise;
  }
  async function getTickerDivergenceSummary(ticker, sourceInterval, options) {
    const normalizedTicker = normalizeTicker(ticker);
    const normalizedSource = sourceInterval ? normalizeSourceInterval(sourceInterval) : getPreferredDivergenceSourceInterval();
    const forceRefresh = options?.forceRefresh === true;
    const noCache = options?.noCache === true;
    if (!normalizedTicker) return null;
    if (!forceRefresh && !noCache) {
      const cached = getCachedSummary(normalizedTicker, normalizedSource);
      if (cached) return cached;
    }
    const resultMap = await fetchDivergenceSummariesBatch(
      [normalizedTicker],
      normalizedSource,
      { forceRefresh, noCache }
    );
    return resultMap.get(normalizedTicker) || null;
  }
  function renderMiniDivergenceRow(root, summary) {
    const nodes = root.querySelectorAll(".div-dot, .divergence-mini-cell");
    nodes.forEach((node) => {
      const dayKey = String(node.dataset.days || "").trim();
      const state = summary?.states?.[dayKey] || "neutral";
      node.classList.remove("is-bullish", "is-bearish", "is-neutral");
      if (state === "bullish") {
        node.classList.add("is-bullish");
      } else if (state === "bearish") {
        node.classList.add("is-bearish");
      } else {
        node.classList.add("is-neutral");
      }
    });
    const parent = root instanceof HTMLElement ? root : root;
    if (parent instanceof HTMLElement) {
      if (summary?.tradeDate) {
        parent.dataset.tradeDate = summary.tradeDate;
        parent.title = `Daily divergence as of ${summary.tradeDate} (${DIVERGENCE_LOOKBACK_DAYS.join(", ")}d)`;
      } else {
        parent.removeAttribute("data-trade-date");
        parent.title = `Daily divergence (${DIVERGENCE_LOOKBACK_DAYS.join(", ")}d)`;
      }
    }
  }
  var DIVERGENCE_SCORE_WEIGHTS = {
    "1": 3,
    "3": 3,
    "7": 2,
    "14": 2,
    "28": 1
  };
  function computeDivergenceScoreFromStates(states, maStates) {
    let total = 0;
    for (const days of DIVERGENCE_LOOKBACK_DAYS) {
      const key = String(days);
      const raw = String(states?.[key] || "").trim().toLowerCase();
      const weight = Number(DIVERGENCE_SCORE_WEIGHTS[key] || 0);
      if (raw === "bullish") {
        total += weight;
      } else if (raw === "bearish") {
        total -= weight;
      }
    }
    if (maStates) {
      total += maStates.ema8 === true ? 1 : maStates.ema8 === false ? -1 : 0;
      total += maStates.ema21 === true ? 1 : maStates.ema21 === false ? -1 : 0;
      total += maStates.sma50 === true ? 1 : maStates.sma50 === false ? -1 : 0;
      total += maStates.sma200 === true ? 1 : maStates.sma200 === false ? -1 : 0;
    }
    return total;
  }
  function getTickerDivergenceScoreFromCache(ticker, sourceInterval) {
    const normalizedTicker = normalizeTicker(ticker);
    if (!normalizedTicker) return 0;
    const normalizedSource = sourceInterval ? normalizeSourceInterval(sourceInterval) : getPreferredDivergenceSourceInterval();
    const summary = getCachedSummary(normalizedTicker, normalizedSource);
    if (!summary) return 0;
    return computeDivergenceScoreFromStates(summary.states);
  }
  function renderAlertCardDivergenceTablesFromCache(container) {
    const normalizedSource = getPreferredDivergenceSourceInterval();
    const cells = Array.from(container.querySelectorAll(".div-dot-row[data-ticker], .divergence-mini[data-ticker]"));
    for (const cell of cells) {
      const ticker = normalizeTicker(cell.dataset.ticker);
      if (!ticker) continue;
      const cached = getCachedSummary(ticker, normalizedSource);
      if (cached) {
        renderMiniDivergenceRow(cell, cached);
      }
    }
  }
  function primeDivergenceSummaryCacheFromAlerts(alerts, sourceInterval) {
    const normalizedSource = sourceInterval ? normalizeSourceInterval(sourceInterval) : getPreferredDivergenceSourceInterval();
    const nowMs = Date.now();
    const expiresAtMs = nowMs + 60 * 60 * 1e3;
    for (const alert of alerts || []) {
      const ticker = normalizeTicker(alert?.ticker);
      if (!ticker) continue;
      const states = buildNeutralStates();
      const rawStates = alert?.divergence_states || {};
      for (const days of DIVERGENCE_LOOKBACK_DAYS) {
        states[String(days)] = normalizeState(rawStates[String(days)]);
      }
      setCachedSummary(normalizedSource, {
        ticker,
        tradeDate: typeof alert?.divergence_trade_date === "string" ? alert.divergence_trade_date : null,
        states,
        expiresAtMs
      });
    }
  }

  // src/utils.ts
  var dateFormatterCache = /* @__PURE__ */ new Map();
  var DAY_MS = 24 * 60 * 60 * 1e3;
  function getDateFormatterForTimeZone(timeZone) {
    const key = `${timeZone}|date`;
    const cached = dateFormatterCache.get(key);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    dateFormatterCache.set(key, formatter);
    return formatter;
  }
  function toNumberPart(parts, type) {
    const value = Number(parts.find((part) => part.type === type)?.value);
    return Number.isFinite(value) ? value : 0;
  }
  function getDatePartsForTimeZone(date, timeZone) {
    const parts = getDateFormatterForTimeZone(timeZone).formatToParts(date);
    return {
      year: toNumberPart(parts, "year"),
      month: toNumberPart(parts, "month"),
      day: toNumberPart(parts, "day")
    };
  }
  function formatDateKey(year, month, day) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  function shiftDateKey(dateKey, dayDelta) {
    const baseMs = dayKeyToUtcMs(dateKey);
    if (!Number.isFinite(baseMs)) return "";
    const shifted = new Date(baseMs + dayDelta * DAY_MS);
    return formatDateKey(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth() + 1,
      shifted.getUTCDate()
    );
  }
  function dayKeyToUtcMs(dayKey) {
    const match = String(dayKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return Date.UTC(year, month - 1, day);
  }
  function getCurrentDateISO(timeZone = getAppTimeZone()) {
    const now = /* @__PURE__ */ new Date();
    const parts = getDatePartsForTimeZone(now, timeZone);
    return formatDateKey(parts.year, parts.month, parts.day);
  }
  function formatVolume(vol) {
    if (!vol) return "0".padEnd(7);
    if (vol < 1e3) return vol.toFixed(0).padEnd(7);
    const str = Math.round(vol / 1e3) + "K";
    return str.padEnd(7);
  }
  function getDateRangeForMode(mode, customFrom = "", customTo = "", timeZone = getAppTimeZone()) {
    const today = getCurrentDateISO(timeZone);
    if (!today) return { startDate: "", endDate: "" };
    if (mode === "1" || mode === "2" || mode === "5") {
      const startDate = shiftDateKey(today, -29);
      return startDate ? { startDate, endDate: today } : { startDate: "", endDate: "" };
    }
    if (mode === "custom") {
      const from = String(customFrom || "").trim();
      const to = String(customTo || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return { startDate: from, endDate: to };
      }
      return { startDate: "", endDate: "" };
    }
    return { startDate: "", endDate: "" };
  }
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function createAlertSortFn(mode, direction = "desc") {
    return (a2, b2) => {
      let result = 0;
      if (mode === "time") {
        result = (b2.timestamp || "").localeCompare(a2.timestamp || "");
      } else if (mode === "favorite") {
        if (a2.is_favorite === b2.is_favorite) {
          return (b2.timestamp || "").localeCompare(a2.timestamp || "");
        }
        return (b2.is_favorite ? 1 : 0) - (a2.is_favorite ? 1 : 0);
      } else if (mode === "volume") {
        result = (b2.signal_volume || 0) - (a2.signal_volume || 0);
      } else if (mode === "score") {
        let bScore = b2.divergence_states ? computeDivergenceScoreFromStates(b2.divergence_states, b2.ma_states) : getTickerDivergenceScoreFromCache(b2.ticker);
        let aScore = a2.divergence_states ? computeDivergenceScoreFromStates(a2.divergence_states, a2.ma_states) : getTickerDivergenceScoreFromCache(a2.ticker);
        if (b2.vdf_score) bScore += Math.round(b2.vdf_score / 10);
        if (a2.vdf_score) aScore += Math.round(a2.vdf_score / 10);
        if (bScore !== aScore) {
          result = bScore - aScore;
        } else {
          const volumeDiff = (b2.signal_volume || 0) - (a2.signal_volume || 0);
          if (volumeDiff !== 0) {
            result = volumeDiff;
          } else {
            result = (b2.timestamp || "").localeCompare(a2.timestamp || "");
          }
        }
      } else {
        result = (b2.timestamp || "").localeCompare(a2.timestamp || "");
      }
      if (mode !== "favorite" && direction === "asc") {
        return -result;
      }
      return result;
    };
  }
  function updateSortButtonUi(containerSelector, currentMode, direction) {
    const header = document.querySelector(containerSelector);
    if (!header) return;
    header.querySelectorAll(".tf-btn").forEach((btn) => {
      const el = btn;
      const mode = el.dataset.sort;
      if (mode === currentMode) {
        el.classList.add("active");
        if (mode !== "favorite") {
          el.setAttribute("data-sort-dir", direction === "asc" ? "\u2191" : "\u2193");
        }
      } else {
        el.classList.remove("active");
        el.removeAttribute("data-sort-dir");
      }
    });
  }

  // src/components.ts
  function formatAlertCardDate(rawDate) {
    const value = String(rawDate || "").trim();
    if (!value) return "";
    const dateOnlyMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateOnlyMatch) {
      const month = Number(dateOnlyMatch[2]);
      const day = Number(dateOnlyMatch[3]);
      if (Number.isFinite(month) && month > 0 && Number.isFinite(day) && day > 0) {
        return `${month}/${day}`;
      }
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return "";
    }
    return `${parsed.getMonth() + 1}/${parsed.getDate()}`;
  }
  function createAlertCard(alert) {
    const timeStr = formatAlertCardDate(alert.signal_trade_date || alert.divergence_trade_date || alert.timestamp) || "--";
    const source = "DataAPI";
    const maStates = alert.ma_states || {};
    let isBull = false;
    let isBear = false;
    if (alert.signal_direction !== void 0 && alert.signal_direction !== null) {
      const dir = Number(alert.signal_direction);
      isBull = dir === 1;
      isBear = dir === -1;
    } else {
      isBull = !!(alert.signal_type && alert.signal_type.toLowerCase().includes("bull"));
      isBear = !isBull;
    }
    const cardClass = isBull ? "bullish-card" : isBear ? "bearish-card" : "";
    const volStr = formatVolume(alert.signal_volume || 0);
    const isFav = alert.is_favorite === true || String(alert.is_favorite).toLowerCase() === "true";
    const starClass = isFav ? "filled" : "";
    const checkmarkVisibility = isFav ? "visible" : "hidden";
    const checkmarkOpacity = isFav ? "1" : "0";
    const starIcon = `
        <svg class="fav-icon ${starClass}" data-id="${alert.id}" data-source="${source}" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.25" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <polyline class="check-mark" points="7.5 12.5 10.5 15.5 16.5 9.5" style="visibility: ${checkmarkVisibility}; opacity: ${checkmarkOpacity};"></polyline>
        </svg>
    `;
    const divergenceDots = DIVERGENCE_LOOKBACK_DAYS.map((days) => {
      const key = String(days);
      const state = String(alert.divergence_states?.[key] || "neutral").toLowerCase();
      const cls = state === "bullish" ? "is-bullish" : state === "bearish" ? "is-bearish" : "is-neutral";
      return `<span class="div-dot ${cls}" data-days="${days}"></span>`;
    }).join("");
    const divergenceTitle = alert.divergence_trade_date ? `Daily divergence as of ${escapeHtml(alert.divergence_trade_date)} (${DIVERGENCE_LOOKBACK_DAYS.join(", ")}d)` : `Daily divergence (${DIVERGENCE_LOOKBACK_DAYS.join(", ")}d)`;
    const maDots = `
        <span class="ma-dot-row" title="8 EMA, 21 EMA, 50 SMA, 200 SMA">
            <span class="ma-dot ${maStates.ema8 ? "is-up" : "is-down"}"></span>
            <span class="ma-dot ${maStates.ema21 ? "is-up" : "is-down"}"></span>
            <span class="ma-dot ${maStates.sma50 ? "is-up" : "is-down"}"></span>
            <span class="ma-dot ${maStates.sma200 ? "is-up" : "is-down"}"></span>
        </span>
    `;
    return `
        <div class="alert-card ${cardClass}" data-ticker="${escapeHtml(alert.ticker)}" data-source="${source}">
            ${starIcon}
            <h3>${escapeHtml(alert.ticker)}</h3>
            
            <div class="metrics-container">
                <div class="metric-item" title="Daily divergence summary">
                    <span class="div-dot-row" data-ticker="${escapeHtml(alert.ticker)}" title="${divergenceTitle}">
                        ${divergenceDots}
                    </span>
                </div>
                <div class="metric-item" title="Signal Volume">
                    <span class="volume-text">${volStr}</span>
                    ${alert.vdf_detected && alert.vdf_score ? `<span class="vdf-score-badge${alert.vdf_proximity === "imminent" ? " vdf-imminent" : alert.vdf_proximity === "high" ? " vdf-high" : ""}" title="VD Accumulation Score: ${alert.vdf_score}">${alert.vdf_score}</span>` : alert.vdf_detected ? '<span class="vdf-tag" title="VD Accumulation detected">VDF</span>' : ""}
                    ${maDots}
                </div>
            </div>

            <span class="alert-time">${timeStr}</span>
        </div>
    `;
  }

  // node_modules/fancy-canvas/size.mjs
  function size(_a) {
    var width = _a.width, height = _a.height;
    if (width < 0) {
      throw new Error("Negative width is not allowed for Size");
    }
    if (height < 0) {
      throw new Error("Negative height is not allowed for Size");
    }
    return {
      width,
      height
    };
  }
  function equalSizes(first, second) {
    return first.width === second.width && first.height === second.height;
  }

  // node_modules/fancy-canvas/device-pixel-ratio.mjs
  var Observable = (
    /** @class */
    (function() {
      function Observable2(win) {
        var _this = this;
        this._resolutionListener = function() {
          return _this._onResolutionChanged();
        };
        this._resolutionMediaQueryList = null;
        this._observers = [];
        this._window = win;
        this._installResolutionListener();
      }
      Observable2.prototype.dispose = function() {
        this._uninstallResolutionListener();
        this._window = null;
      };
      Object.defineProperty(Observable2.prototype, "value", {
        get: function() {
          return this._window.devicePixelRatio;
        },
        enumerable: false,
        configurable: true
      });
      Observable2.prototype.subscribe = function(next) {
        var _this = this;
        var observer = { next };
        this._observers.push(observer);
        return {
          unsubscribe: function() {
            _this._observers = _this._observers.filter(function(o2) {
              return o2 !== observer;
            });
          }
        };
      };
      Observable2.prototype._installResolutionListener = function() {
        if (this._resolutionMediaQueryList !== null) {
          throw new Error("Resolution listener is already installed");
        }
        var dppx = this._window.devicePixelRatio;
        this._resolutionMediaQueryList = this._window.matchMedia("all and (resolution: ".concat(dppx, "dppx)"));
        this._resolutionMediaQueryList.addListener(this._resolutionListener);
      };
      Observable2.prototype._uninstallResolutionListener = function() {
        if (this._resolutionMediaQueryList !== null) {
          this._resolutionMediaQueryList.removeListener(this._resolutionListener);
          this._resolutionMediaQueryList = null;
        }
      };
      Observable2.prototype._reinstallResolutionListener = function() {
        this._uninstallResolutionListener();
        this._installResolutionListener();
      };
      Observable2.prototype._onResolutionChanged = function() {
        var _this = this;
        this._observers.forEach(function(observer) {
          return observer.next(_this._window.devicePixelRatio);
        });
        this._reinstallResolutionListener();
      };
      return Observable2;
    })()
  );
  function createObservable(win) {
    return new Observable(win);
  }

  // node_modules/fancy-canvas/canvas-element-bitmap-size.mjs
  var DevicePixelContentBoxBinding = (
    /** @class */
    (function() {
      function DevicePixelContentBoxBinding2(canvasElement, transformBitmapSize, options) {
        var _a;
        this._canvasElement = null;
        this._bitmapSizeChangedListeners = [];
        this._suggestedBitmapSize = null;
        this._suggestedBitmapSizeChangedListeners = [];
        this._devicePixelRatioObservable = null;
        this._canvasElementResizeObserver = null;
        this._canvasElement = canvasElement;
        this._canvasElementClientSize = size({
          width: this._canvasElement.clientWidth,
          height: this._canvasElement.clientHeight
        });
        this._transformBitmapSize = transformBitmapSize !== null && transformBitmapSize !== void 0 ? transformBitmapSize : (function(size2) {
          return size2;
        });
        this._allowResizeObserver = (_a = options === null || options === void 0 ? void 0 : options.allowResizeObserver) !== null && _a !== void 0 ? _a : true;
        this._chooseAndInitObserver();
      }
      DevicePixelContentBoxBinding2.prototype.dispose = function() {
        var _a, _b;
        if (this._canvasElement === null) {
          throw new Error("Object is disposed");
        }
        (_a = this._canvasElementResizeObserver) === null || _a === void 0 ? void 0 : _a.disconnect();
        this._canvasElementResizeObserver = null;
        (_b = this._devicePixelRatioObservable) === null || _b === void 0 ? void 0 : _b.dispose();
        this._devicePixelRatioObservable = null;
        this._suggestedBitmapSizeChangedListeners.length = 0;
        this._bitmapSizeChangedListeners.length = 0;
        this._canvasElement = null;
      };
      Object.defineProperty(DevicePixelContentBoxBinding2.prototype, "canvasElement", {
        get: function() {
          if (this._canvasElement === null) {
            throw new Error("Object is disposed");
          }
          return this._canvasElement;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DevicePixelContentBoxBinding2.prototype, "canvasElementClientSize", {
        get: function() {
          return this._canvasElementClientSize;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(DevicePixelContentBoxBinding2.prototype, "bitmapSize", {
        get: function() {
          return size({
            width: this.canvasElement.width,
            height: this.canvasElement.height
          });
        },
        enumerable: false,
        configurable: true
      });
      DevicePixelContentBoxBinding2.prototype.resizeCanvasElement = function(clientSize) {
        this._canvasElementClientSize = size(clientSize);
        this.canvasElement.style.width = "".concat(this._canvasElementClientSize.width, "px");
        this.canvasElement.style.height = "".concat(this._canvasElementClientSize.height, "px");
        this._invalidateBitmapSize();
      };
      DevicePixelContentBoxBinding2.prototype.subscribeBitmapSizeChanged = function(listener) {
        this._bitmapSizeChangedListeners.push(listener);
      };
      DevicePixelContentBoxBinding2.prototype.unsubscribeBitmapSizeChanged = function(listener) {
        this._bitmapSizeChangedListeners = this._bitmapSizeChangedListeners.filter(function(l2) {
          return l2 !== listener;
        });
      };
      Object.defineProperty(DevicePixelContentBoxBinding2.prototype, "suggestedBitmapSize", {
        get: function() {
          return this._suggestedBitmapSize;
        },
        enumerable: false,
        configurable: true
      });
      DevicePixelContentBoxBinding2.prototype.subscribeSuggestedBitmapSizeChanged = function(listener) {
        this._suggestedBitmapSizeChangedListeners.push(listener);
      };
      DevicePixelContentBoxBinding2.prototype.unsubscribeSuggestedBitmapSizeChanged = function(listener) {
        this._suggestedBitmapSizeChangedListeners = this._suggestedBitmapSizeChangedListeners.filter(function(l2) {
          return l2 !== listener;
        });
      };
      DevicePixelContentBoxBinding2.prototype.applySuggestedBitmapSize = function() {
        if (this._suggestedBitmapSize === null) {
          return;
        }
        var oldSuggestedSize = this._suggestedBitmapSize;
        this._suggestedBitmapSize = null;
        this._resizeBitmap(oldSuggestedSize);
        this._emitSuggestedBitmapSizeChanged(oldSuggestedSize, this._suggestedBitmapSize);
      };
      DevicePixelContentBoxBinding2.prototype._resizeBitmap = function(newSize) {
        var oldSize = this.bitmapSize;
        if (equalSizes(oldSize, newSize)) {
          return;
        }
        this.canvasElement.width = newSize.width;
        this.canvasElement.height = newSize.height;
        this._emitBitmapSizeChanged(oldSize, newSize);
      };
      DevicePixelContentBoxBinding2.prototype._emitBitmapSizeChanged = function(oldSize, newSize) {
        var _this = this;
        this._bitmapSizeChangedListeners.forEach(function(listener) {
          return listener.call(_this, oldSize, newSize);
        });
      };
      DevicePixelContentBoxBinding2.prototype._suggestNewBitmapSize = function(newSize) {
        var oldSuggestedSize = this._suggestedBitmapSize;
        var finalNewSize = size(this._transformBitmapSize(newSize, this._canvasElementClientSize));
        var newSuggestedSize = equalSizes(this.bitmapSize, finalNewSize) ? null : finalNewSize;
        if (oldSuggestedSize === null && newSuggestedSize === null) {
          return;
        }
        if (oldSuggestedSize !== null && newSuggestedSize !== null && equalSizes(oldSuggestedSize, newSuggestedSize)) {
          return;
        }
        this._suggestedBitmapSize = newSuggestedSize;
        this._emitSuggestedBitmapSizeChanged(oldSuggestedSize, newSuggestedSize);
      };
      DevicePixelContentBoxBinding2.prototype._emitSuggestedBitmapSizeChanged = function(oldSize, newSize) {
        var _this = this;
        this._suggestedBitmapSizeChangedListeners.forEach(function(listener) {
          return listener.call(_this, oldSize, newSize);
        });
      };
      DevicePixelContentBoxBinding2.prototype._chooseAndInitObserver = function() {
        var _this = this;
        if (!this._allowResizeObserver) {
          this._initDevicePixelRatioObservable();
          return;
        }
        isDevicePixelContentBoxSupported().then(function(isSupported) {
          return isSupported ? _this._initResizeObserver() : _this._initDevicePixelRatioObservable();
        });
      };
      DevicePixelContentBoxBinding2.prototype._initDevicePixelRatioObservable = function() {
        var _this = this;
        if (this._canvasElement === null) {
          return;
        }
        var win = canvasElementWindow(this._canvasElement);
        if (win === null) {
          throw new Error("No window is associated with the canvas");
        }
        this._devicePixelRatioObservable = createObservable(win);
        this._devicePixelRatioObservable.subscribe(function() {
          return _this._invalidateBitmapSize();
        });
        this._invalidateBitmapSize();
      };
      DevicePixelContentBoxBinding2.prototype._invalidateBitmapSize = function() {
        var _a, _b;
        if (this._canvasElement === null) {
          return;
        }
        var win = canvasElementWindow(this._canvasElement);
        if (win === null) {
          return;
        }
        var ratio = (_b = (_a = this._devicePixelRatioObservable) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : win.devicePixelRatio;
        var canvasRects = this._canvasElement.getClientRects();
        var newSize = (
          // eslint-disable-next-line no-negated-condition
          canvasRects[0] !== void 0 ? predictedBitmapSize(canvasRects[0], ratio) : size({
            width: this._canvasElementClientSize.width * ratio,
            height: this._canvasElementClientSize.height * ratio
          })
        );
        this._suggestNewBitmapSize(newSize);
      };
      DevicePixelContentBoxBinding2.prototype._initResizeObserver = function() {
        var _this = this;
        if (this._canvasElement === null) {
          return;
        }
        this._canvasElementResizeObserver = new ResizeObserver(function(entries) {
          var entry = entries.find(function(entry2) {
            return entry2.target === _this._canvasElement;
          });
          if (!entry || !entry.devicePixelContentBoxSize || !entry.devicePixelContentBoxSize[0]) {
            return;
          }
          var entrySize = entry.devicePixelContentBoxSize[0];
          var newSize = size({
            width: entrySize.inlineSize,
            height: entrySize.blockSize
          });
          _this._suggestNewBitmapSize(newSize);
        });
        this._canvasElementResizeObserver.observe(this._canvasElement, { box: "device-pixel-content-box" });
      };
      return DevicePixelContentBoxBinding2;
    })()
  );
  function bindTo(canvasElement, target) {
    if (target.type === "device-pixel-content-box") {
      return new DevicePixelContentBoxBinding(canvasElement, target.transform, target.options);
    }
    throw new Error("Unsupported binding target");
  }
  function canvasElementWindow(canvasElement) {
    return canvasElement.ownerDocument.defaultView;
  }
  function isDevicePixelContentBoxSupported() {
    return new Promise(function(resolve) {
      var ro = new ResizeObserver(function(entries) {
        resolve(entries.every(function(entry) {
          return "devicePixelContentBoxSize" in entry;
        }));
        ro.disconnect();
      });
      ro.observe(document.body, { box: "device-pixel-content-box" });
    }).catch(function() {
      return false;
    });
  }
  function predictedBitmapSize(canvasRect, ratio) {
    return size({
      width: Math.round(canvasRect.left * ratio + canvasRect.width * ratio) - Math.round(canvasRect.left * ratio),
      height: Math.round(canvasRect.top * ratio + canvasRect.height * ratio) - Math.round(canvasRect.top * ratio)
    });
  }

  // node_modules/fancy-canvas/canvas-rendering-target.mjs
  var CanvasRenderingTarget2D = (
    /** @class */
    (function() {
      function CanvasRenderingTarget2D2(context, mediaSize, bitmapSize) {
        if (mediaSize.width === 0 || mediaSize.height === 0) {
          throw new TypeError("Rendering target could only be created on a media with positive width and height");
        }
        this._mediaSize = mediaSize;
        if (bitmapSize.width === 0 || bitmapSize.height === 0) {
          throw new TypeError("Rendering target could only be created using a bitmap with positive integer width and height");
        }
        this._bitmapSize = bitmapSize;
        this._context = context;
      }
      CanvasRenderingTarget2D2.prototype.useMediaCoordinateSpace = function(f2) {
        try {
          this._context.save();
          this._context.setTransform(1, 0, 0, 1, 0, 0);
          this._context.scale(this._horizontalPixelRatio, this._verticalPixelRatio);
          return f2({
            context: this._context,
            mediaSize: this._mediaSize
          });
        } finally {
          this._context.restore();
        }
      };
      CanvasRenderingTarget2D2.prototype.useBitmapCoordinateSpace = function(f2) {
        try {
          this._context.save();
          this._context.setTransform(1, 0, 0, 1, 0, 0);
          return f2({
            context: this._context,
            mediaSize: this._mediaSize,
            bitmapSize: this._bitmapSize,
            horizontalPixelRatio: this._horizontalPixelRatio,
            verticalPixelRatio: this._verticalPixelRatio
          });
        } finally {
          this._context.restore();
        }
      };
      Object.defineProperty(CanvasRenderingTarget2D2.prototype, "_horizontalPixelRatio", {
        get: function() {
          return this._bitmapSize.width / this._mediaSize.width;
        },
        enumerable: false,
        configurable: true
      });
      Object.defineProperty(CanvasRenderingTarget2D2.prototype, "_verticalPixelRatio", {
        get: function() {
          return this._bitmapSize.height / this._mediaSize.height;
        },
        enumerable: false,
        configurable: true
      });
      return CanvasRenderingTarget2D2;
    })()
  );
  function tryCreateCanvasRenderingTarget2D(binding, contextOptions) {
    var mediaSize = binding.canvasElementClientSize;
    if (mediaSize.width === 0 || mediaSize.height === 0) {
      return null;
    }
    var bitmapSize = binding.bitmapSize;
    if (bitmapSize.width === 0 || bitmapSize.height === 0) {
      return null;
    }
    var context = binding.canvasElement.getContext("2d", contextOptions);
    if (context === null) {
      return null;
    }
    return new CanvasRenderingTarget2D(context, mediaSize, bitmapSize);
  }

  // node_modules/lightweight-charts/dist/lightweight-charts.production.mjs
  var e = { upColor: "#26a69a", downColor: "#ef5350", wickVisible: true, borderVisible: true, borderColor: "#378658", borderUpColor: "#26a69a", borderDownColor: "#ef5350", wickColor: "#737375", wickUpColor: "#26a69a", wickDownColor: "#ef5350" };
  var r = { upColor: "#26a69a", downColor: "#ef5350", openVisible: true, thinBars: true };
  var h = { color: "#2196f3", lineStyle: 0, lineWidth: 3, lineType: 0, lineVisible: true, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: "", crosshairMarkerBorderWidth: 2, crosshairMarkerBackgroundColor: "", lastPriceAnimation: 0, pointMarkersVisible: false };
  var l = { topColor: "rgba( 46, 220, 135, 0.4)", bottomColor: "rgba( 40, 221, 100, 0)", invertFilledArea: false, lineColor: "#33D778", lineStyle: 0, lineWidth: 3, lineType: 0, lineVisible: true, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: "", crosshairMarkerBorderWidth: 2, crosshairMarkerBackgroundColor: "", lastPriceAnimation: 0, pointMarkersVisible: false };
  var a = { baseValue: { type: "price", price: 0 }, topFillColor1: "rgba(38, 166, 154, 0.28)", topFillColor2: "rgba(38, 166, 154, 0.05)", topLineColor: "rgba(38, 166, 154, 1)", bottomFillColor1: "rgba(239, 83, 80, 0.05)", bottomFillColor2: "rgba(239, 83, 80, 0.28)", bottomLineColor: "rgba(239, 83, 80, 1)", lineWidth: 3, lineStyle: 0, lineType: 0, lineVisible: true, crosshairMarkerVisible: true, crosshairMarkerRadius: 4, crosshairMarkerBorderColor: "", crosshairMarkerBorderWidth: 2, crosshairMarkerBackgroundColor: "", lastPriceAnimation: 0, pointMarkersVisible: false };
  var o = { color: "#26a69a", base: 0 };
  var _ = { color: "#2196f3" };
  var u = { title: "", visible: true, lastValueVisible: true, priceLineVisible: true, priceLineSource: 0, priceLineWidth: 1, priceLineColor: "", priceLineStyle: 2, baseLineVisible: true, baseLineWidth: 1, baseLineColor: "#B2B5BE", baseLineStyle: 0, priceFormat: { type: "price", precision: 2, minMove: 0.01 } };
  var c;
  var d;
  function f(t, i) {
    const n = { 0: [], 1: [t.lineWidth, t.lineWidth], 2: [2 * t.lineWidth, 2 * t.lineWidth], 3: [6 * t.lineWidth, 6 * t.lineWidth], 4: [t.lineWidth, 4 * t.lineWidth] }[i];
    t.setLineDash(n);
  }
  function v(t, i, n, s) {
    t.beginPath();
    const e2 = t.lineWidth % 2 ? 0.5 : 0;
    t.moveTo(n, i + e2), t.lineTo(s, i + e2), t.stroke();
  }
  function p(t, i) {
    if (!t) throw new Error("Assertion failed" + (i ? ": " + i : ""));
  }
  function m(t) {
    if (void 0 === t) throw new Error("Value is undefined");
    return t;
  }
  function b(t) {
    if (null === t) throw new Error("Value is null");
    return t;
  }
  function w(t) {
    return b(m(t));
  }
  !(function(t) {
    t[t.Simple = 0] = "Simple", t[t.WithSteps = 1] = "WithSteps", t[t.Curved = 2] = "Curved";
  })(c || (c = {})), (function(t) {
    t[t.Solid = 0] = "Solid", t[t.Dotted = 1] = "Dotted", t[t.Dashed = 2] = "Dashed", t[t.LargeDashed = 3] = "LargeDashed", t[t.SparseDotted = 4] = "SparseDotted";
  })(d || (d = {}));
  var g = { khaki: "#f0e68c", azure: "#f0ffff", aliceblue: "#f0f8ff", ghostwhite: "#f8f8ff", gold: "#ffd700", goldenrod: "#daa520", gainsboro: "#dcdcdc", gray: "#808080", green: "#008000", honeydew: "#f0fff0", floralwhite: "#fffaf0", lightblue: "#add8e6", lightcoral: "#f08080", lemonchiffon: "#fffacd", hotpink: "#ff69b4", lightyellow: "#ffffe0", greenyellow: "#adff2f", lightgoldenrodyellow: "#fafad2", limegreen: "#32cd32", linen: "#faf0e6", lightcyan: "#e0ffff", magenta: "#f0f", maroon: "#800000", olive: "#808000", orange: "#ffa500", oldlace: "#fdf5e6", mediumblue: "#0000cd", transparent: "#0000", lime: "#0f0", lightpink: "#ffb6c1", mistyrose: "#ffe4e1", moccasin: "#ffe4b5", midnightblue: "#191970", orchid: "#da70d6", mediumorchid: "#ba55d3", mediumturquoise: "#48d1cc", orangered: "#ff4500", royalblue: "#4169e1", powderblue: "#b0e0e6", red: "#f00", coral: "#ff7f50", turquoise: "#40e0d0", white: "#fff", whitesmoke: "#f5f5f5", wheat: "#f5deb3", teal: "#008080", steelblue: "#4682b4", bisque: "#ffe4c4", aquamarine: "#7fffd4", aqua: "#0ff", sienna: "#a0522d", silver: "#c0c0c0", springgreen: "#00ff7f", antiquewhite: "#faebd7", burlywood: "#deb887", brown: "#a52a2a", beige: "#f5f5dc", chocolate: "#d2691e", chartreuse: "#7fff00", cornflowerblue: "#6495ed", cornsilk: "#fff8dc", crimson: "#dc143c", cadetblue: "#5f9ea0", tomato: "#ff6347", fuchsia: "#f0f", blue: "#00f", salmon: "#fa8072", blanchedalmond: "#ffebcd", slateblue: "#6a5acd", slategray: "#708090", thistle: "#d8bfd8", tan: "#d2b48c", cyan: "#0ff", darkblue: "#00008b", darkcyan: "#008b8b", darkgoldenrod: "#b8860b", darkgray: "#a9a9a9", blueviolet: "#8a2be2", black: "#000", darkmagenta: "#8b008b", darkslateblue: "#483d8b", darkkhaki: "#bdb76b", darkorchid: "#9932cc", darkorange: "#ff8c00", darkgreen: "#006400", darkred: "#8b0000", dodgerblue: "#1e90ff", darkslategray: "#2f4f4f", dimgray: "#696969", deepskyblue: "#00bfff", firebrick: "#b22222", forestgreen: "#228b22", indigo: "#4b0082", ivory: "#fffff0", lavenderblush: "#fff0f5", feldspar: "#d19275", indianred: "#cd5c5c", lightgreen: "#90ee90", lightgrey: "#d3d3d3", lightskyblue: "#87cefa", lightslategray: "#789", lightslateblue: "#8470ff", snow: "#fffafa", lightseagreen: "#20b2aa", lightsalmon: "#ffa07a", darksalmon: "#e9967a", darkviolet: "#9400d3", mediumpurple: "#9370d8", mediumaquamarine: "#66cdaa", skyblue: "#87ceeb", lavender: "#e6e6fa", lightsteelblue: "#b0c4de", mediumvioletred: "#c71585", mintcream: "#f5fffa", navajowhite: "#ffdead", navy: "#000080", olivedrab: "#6b8e23", palevioletred: "#d87093", violetred: "#d02090", yellow: "#ff0", yellowgreen: "#9acd32", lawngreen: "#7cfc00", pink: "#ffc0cb", paleturquoise: "#afeeee", palegoldenrod: "#eee8aa", darkolivegreen: "#556b2f", darkseagreen: "#8fbc8f", darkturquoise: "#00ced1", peachpuff: "#ffdab9", deeppink: "#ff1493", violet: "#ee82ee", palegreen: "#98fb98", mediumseagreen: "#3cb371", peru: "#cd853f", saddlebrown: "#8b4513", sandybrown: "#f4a460", rosybrown: "#bc8f8f", purple: "#800080", seagreen: "#2e8b57", seashell: "#fff5ee", papayawhip: "#ffefd5", mediumslateblue: "#7b68ee", plum: "#dda0dd", mediumspringgreen: "#00fa9a" };
  function M(t) {
    return t < 0 ? 0 : t > 255 ? 255 : Math.round(t) || 0;
  }
  function x(t) {
    return t <= 0 || t > 1 ? Math.min(Math.max(t, 0), 1) : Math.round(1e4 * t) / 1e4;
  }
  var S = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
  var k = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;
  var y = /^rgb\(\s*(-?\d{1,10})\s*,\s*(-?\d{1,10})\s*,\s*(-?\d{1,10})\s*\)$/;
  var C = /^rgba\(\s*(-?\d{1,10})\s*,\s*(-?\d{1,10})\s*,\s*(-?\d{1,10})\s*,\s*(-?\d*\.?\d+)\s*\)$/;
  function T(t) {
    (t = t.toLowerCase()) in g && (t = g[t]);
    {
      const i = C.exec(t) || y.exec(t);
      if (i) return [M(parseInt(i[1], 10)), M(parseInt(i[2], 10)), M(parseInt(i[3], 10)), x(i.length < 5 ? 1 : parseFloat(i[4]))];
    }
    {
      const i = k.exec(t);
      if (i) return [M(parseInt(i[1], 16)), M(parseInt(i[2], 16)), M(parseInt(i[3], 16)), 1];
    }
    {
      const i = S.exec(t);
      if (i) return [M(17 * parseInt(i[1], 16)), M(17 * parseInt(i[2], 16)), M(17 * parseInt(i[3], 16)), 1];
    }
    throw new Error(`Cannot parse color: ${t}`);
  }
  function P(t) {
    return 0.199 * t[0] + 0.687 * t[1] + 0.114 * t[2];
  }
  function R(t) {
    const i = T(t);
    return { t: `rgb(${i[0]}, ${i[1]}, ${i[2]})`, i: P(i) > 160 ? "black" : "white" };
  }
  var D = class {
    constructor() {
      this.h = [];
    }
    l(t, i, n) {
      const s = { o: t, _: i, u: true === n };
      this.h.push(s);
    }
    v(t) {
      const i = this.h.findIndex(((i2) => t === i2.o));
      i > -1 && this.h.splice(i, 1);
    }
    p(t) {
      this.h = this.h.filter(((i) => i._ !== t));
    }
    m(t, i, n) {
      const s = [...this.h];
      this.h = this.h.filter(((t2) => !t2.u)), s.forEach(((s2) => s2.o(t, i, n)));
    }
    M() {
      return this.h.length > 0;
    }
    S() {
      this.h = [];
    }
  };
  function V(t, ...i) {
    for (const n of i) for (const i2 in n) void 0 !== n[i2] && ("object" != typeof n[i2] || void 0 === t[i2] || Array.isArray(n[i2]) ? t[i2] = n[i2] : V(t[i2], n[i2]));
    return t;
  }
  function O(t) {
    return "number" == typeof t && isFinite(t);
  }
  function B(t) {
    return "number" == typeof t && t % 1 == 0;
  }
  function A(t) {
    return "string" == typeof t;
  }
  function I(t) {
    return "boolean" == typeof t;
  }
  function z(t) {
    const i = t;
    if (!i || "object" != typeof i) return i;
    let n, s, e2;
    for (s in n = Array.isArray(i) ? [] : {}, i) i.hasOwnProperty(s) && (e2 = i[s], n[s] = e2 && "object" == typeof e2 ? z(e2) : e2);
    return n;
  }
  function L(t) {
    return null !== t;
  }
  function E(t) {
    return null === t ? void 0 : t;
  }
  var N = "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
  function F(t, i, n) {
    return void 0 === i && (i = N), `${n = void 0 !== n ? `${n} ` : ""}${t}px ${i}`;
  }
  var W = class {
    constructor(t) {
      this.k = { C: 1, T: 5, P: NaN, R: "", D: "", V: "", O: "", B: 0, A: 0, I: 0, L: 0, N: 0 }, this.F = t;
    }
    W() {
      const t = this.k, i = this.j(), n = this.H();
      return t.P === i && t.D === n || (t.P = i, t.D = n, t.R = F(i, n), t.L = 2.5 / 12 * i, t.B = t.L, t.A = i / 12 * t.T, t.I = i / 12 * t.T, t.N = 0), t.V = this.$(), t.O = this.U(), this.k;
    }
    $() {
      return this.F.W().layout.textColor;
    }
    U() {
      return this.F.q();
    }
    j() {
      return this.F.W().layout.fontSize;
    }
    H() {
      return this.F.W().layout.fontFamily;
    }
  };
  var j = class {
    constructor() {
      this.Y = [];
    }
    Z(t) {
      this.Y = t;
    }
    X(t, i, n) {
      this.Y.forEach(((s) => {
        s.X(t, i, n);
      }));
    }
  };
  var H = class {
    X(t, i, n) {
      t.useBitmapCoordinateSpace(((t2) => this.K(t2, i, n)));
    }
  };
  var $ = class extends H {
    constructor() {
      super(...arguments), this.G = null;
    }
    J(t) {
      this.G = t;
    }
    K({ context: t, horizontalPixelRatio: i, verticalPixelRatio: n }) {
      if (null === this.G || null === this.G.tt) return;
      const s = this.G.tt, e2 = this.G, r2 = Math.max(1, Math.floor(i)) % 2 / 2, h2 = (h3) => {
        t.beginPath();
        for (let l2 = s.to - 1; l2 >= s.from; --l2) {
          const s2 = e2.it[l2], a2 = Math.round(s2.nt * i) + r2, o2 = s2.st * n, _2 = h3 * n + r2;
          t.moveTo(a2, o2), t.arc(a2, o2, _2, 0, 2 * Math.PI);
        }
        t.fill();
      };
      e2.et > 0 && (t.fillStyle = e2.rt, h2(e2.ht + e2.et)), t.fillStyle = e2.lt, h2(e2.ht);
    }
  };
  function U() {
    return { it: [{ nt: 0, st: 0, ot: 0, _t: 0 }], lt: "", rt: "", ht: 0, et: 0, tt: null };
  }
  var q = { from: 0, to: 1 };
  var Y = class {
    constructor(t, i) {
      this.ut = new j(), this.ct = [], this.dt = [], this.ft = true, this.F = t, this.vt = i, this.ut.Z(this.ct);
    }
    bt(t) {
      const i = this.F.wt();
      i.length !== this.ct.length && (this.dt = i.map(U), this.ct = this.dt.map(((t2) => {
        const i2 = new $();
        return i2.J(t2), i2;
      })), this.ut.Z(this.ct)), this.ft = true;
    }
    gt() {
      return this.ft && (this.Mt(), this.ft = false), this.ut;
    }
    Mt() {
      const t = 2 === this.vt.W().mode, i = this.F.wt(), n = this.vt.xt(), s = this.F.St();
      i.forEach(((i2, e2) => {
        var r2;
        const h2 = this.dt[e2], l2 = i2.kt(n);
        if (t || null === l2 || !i2.yt()) return void (h2.tt = null);
        const a2 = b(i2.Ct());
        h2.lt = l2.Tt, h2.ht = l2.ht, h2.et = l2.Pt, h2.it[0]._t = l2._t, h2.it[0].st = i2.Dt().Rt(l2._t, a2.Vt), h2.rt = null !== (r2 = l2.Ot) && void 0 !== r2 ? r2 : this.F.Bt(h2.it[0].st / i2.Dt().At()), h2.it[0].ot = n, h2.it[0].nt = s.It(n), h2.tt = q;
      }));
    }
  };
  var Z = class extends H {
    constructor(t) {
      super(), this.zt = t;
    }
    K({ context: t, bitmapSize: i, horizontalPixelRatio: n, verticalPixelRatio: s }) {
      if (null === this.zt) return;
      const e2 = this.zt.Lt.yt, r2 = this.zt.Et.yt;
      if (!e2 && !r2) return;
      const h2 = Math.round(this.zt.nt * n), l2 = Math.round(this.zt.st * s);
      t.lineCap = "butt", e2 && h2 >= 0 && (t.lineWidth = Math.floor(this.zt.Lt.et * n), t.strokeStyle = this.zt.Lt.V, t.fillStyle = this.zt.Lt.V, f(t, this.zt.Lt.Nt), (function(t2, i2, n2, s2) {
        t2.beginPath();
        const e3 = t2.lineWidth % 2 ? 0.5 : 0;
        t2.moveTo(i2 + e3, n2), t2.lineTo(i2 + e3, s2), t2.stroke();
      })(t, h2, 0, i.height)), r2 && l2 >= 0 && (t.lineWidth = Math.floor(this.zt.Et.et * s), t.strokeStyle = this.zt.Et.V, t.fillStyle = this.zt.Et.V, f(t, this.zt.Et.Nt), v(t, l2, 0, i.width));
    }
  };
  var X = class {
    constructor(t) {
      this.ft = true, this.Ft = { Lt: { et: 1, Nt: 0, V: "", yt: false }, Et: { et: 1, Nt: 0, V: "", yt: false }, nt: 0, st: 0 }, this.Wt = new Z(this.Ft), this.jt = t;
    }
    bt() {
      this.ft = true;
    }
    gt() {
      return this.ft && (this.Mt(), this.ft = false), this.Wt;
    }
    Mt() {
      const t = this.jt.yt(), i = b(this.jt.Ht()), n = i.$t().W().crosshair, s = this.Ft;
      if (2 === n.mode) return s.Et.yt = false, void (s.Lt.yt = false);
      s.Et.yt = t && this.jt.Ut(i), s.Lt.yt = t && this.jt.qt(), s.Et.et = n.horzLine.width, s.Et.Nt = n.horzLine.style, s.Et.V = n.horzLine.color, s.Lt.et = n.vertLine.width, s.Lt.Nt = n.vertLine.style, s.Lt.V = n.vertLine.color, s.nt = this.jt.Yt(), s.st = this.jt.Zt();
    }
  };
  function K(t, i, n, s, e2, r2) {
    t.fillRect(i + r2, n, s - 2 * r2, r2), t.fillRect(i + r2, n + e2 - r2, s - 2 * r2, r2), t.fillRect(i, n, r2, e2), t.fillRect(i + s - r2, n, r2, e2);
  }
  function G(t, i, n, s, e2, r2) {
    t.save(), t.globalCompositeOperation = "copy", t.fillStyle = r2, t.fillRect(i, n, s, e2), t.restore();
  }
  function J(t, i, n, s, e2, r2) {
    t.beginPath(), t.roundRect ? t.roundRect(i, n, s, e2, r2) : (t.lineTo(i + s - r2[1], n), 0 !== r2[1] && t.arcTo(i + s, n, i + s, n + r2[1], r2[1]), t.lineTo(i + s, n + e2 - r2[2]), 0 !== r2[2] && t.arcTo(i + s, n + e2, i + s - r2[2], n + e2, r2[2]), t.lineTo(i + r2[3], n + e2), 0 !== r2[3] && t.arcTo(i, n + e2, i, n + e2 - r2[3], r2[3]), t.lineTo(i, n + r2[0]), 0 !== r2[0] && t.arcTo(i, n, i + r2[0], n, r2[0]));
  }
  function Q(t, i, n, s, e2, r2, h2 = 0, l2 = [0, 0, 0, 0], a2 = "") {
    if (t.save(), !h2 || !a2 || a2 === r2) return J(t, i, n, s, e2, l2), t.fillStyle = r2, t.fill(), void t.restore();
    const o2 = h2 / 2;
    var _2;
    J(t, i + o2, n + o2, s - h2, e2 - h2, (_2 = -o2, l2.map(((t2) => 0 === t2 ? t2 : t2 + _2)))), "transparent" !== r2 && (t.fillStyle = r2, t.fill()), "transparent" !== a2 && (t.lineWidth = h2, t.strokeStyle = a2, t.closePath(), t.stroke()), t.restore();
  }
  function tt(t, i, n, s, e2, r2, h2) {
    t.save(), t.globalCompositeOperation = "copy";
    const l2 = t.createLinearGradient(0, 0, 0, e2);
    l2.addColorStop(0, r2), l2.addColorStop(1, h2), t.fillStyle = l2, t.fillRect(i, n, s, e2), t.restore();
  }
  var it = class {
    constructor(t, i) {
      this.J(t, i);
    }
    J(t, i) {
      this.zt = t, this.Xt = i;
    }
    At(t, i) {
      return this.zt.yt ? t.P + t.L + t.B : 0;
    }
    X(t, i, n, s) {
      if (!this.zt.yt || 0 === this.zt.Kt.length) return;
      const e2 = this.zt.V, r2 = this.Xt.t, h2 = t.useBitmapCoordinateSpace(((t2) => {
        const h3 = t2.context;
        h3.font = i.R;
        const l2 = this.Gt(t2, i, n, s), a2 = l2.Jt;
        return l2.Qt ? Q(h3, a2.ti, a2.ii, a2.ni, a2.si, r2, a2.ei, [a2.ht, 0, 0, a2.ht], r2) : Q(h3, a2.ri, a2.ii, a2.ni, a2.si, r2, a2.ei, [0, a2.ht, a2.ht, 0], r2), this.zt.hi && (h3.fillStyle = e2, h3.fillRect(a2.ri, a2.li, a2.ai - a2.ri, a2.oi)), this.zt._i && (h3.fillStyle = i.O, h3.fillRect(l2.Qt ? a2.ui - a2.ei : 0, a2.ii, a2.ei, a2.ci - a2.ii)), l2;
      }));
      t.useMediaCoordinateSpace((({ context: t2 }) => {
        const n2 = h2.di;
        t2.font = i.R, t2.textAlign = h2.Qt ? "right" : "left", t2.textBaseline = "middle", t2.fillStyle = e2, t2.fillText(this.zt.Kt, n2.fi, (n2.ii + n2.ci) / 2 + n2.pi);
      }));
    }
    Gt(t, i, n, s) {
      var e2;
      const { context: r2, bitmapSize: h2, mediaSize: l2, horizontalPixelRatio: a2, verticalPixelRatio: o2 } = t, _2 = this.zt.hi || !this.zt.mi ? i.T : 0, u2 = this.zt.bi ? i.C : 0, c2 = i.L + this.Xt.wi, d2 = i.B + this.Xt.gi, f2 = i.A, v2 = i.I, p2 = this.zt.Kt, m2 = i.P, b2 = n.Mi(r2, p2), w2 = Math.ceil(n.xi(r2, p2)), g2 = m2 + c2 + d2, M2 = i.C + f2 + v2 + w2 + _2, x2 = Math.max(1, Math.floor(o2));
      let S2 = Math.round(g2 * o2);
      S2 % 2 != x2 % 2 && (S2 += 1);
      const k2 = u2 > 0 ? Math.max(1, Math.floor(u2 * a2)) : 0, y2 = Math.round(M2 * a2), C2 = Math.round(_2 * a2), T2 = null !== (e2 = this.Xt.Si) && void 0 !== e2 ? e2 : this.Xt.ki, P2 = Math.round(T2 * o2) - Math.floor(0.5 * o2), R2 = Math.floor(P2 + x2 / 2 - S2 / 2), D2 = R2 + S2, V2 = "right" === s, O2 = V2 ? l2.width - u2 : u2, B2 = V2 ? h2.width - k2 : k2;
      let A2, I2, z2;
      return V2 ? (A2 = B2 - y2, I2 = B2 - C2, z2 = O2 - _2 - f2 - u2) : (A2 = B2 + y2, I2 = B2 + C2, z2 = O2 + _2 + f2), { Qt: V2, Jt: { ii: R2, li: P2, ci: D2, ni: y2, si: S2, ht: 2 * a2, ei: k2, ti: A2, ri: B2, ai: I2, oi: x2, ui: h2.width }, di: { ii: R2 / o2, ci: D2 / o2, fi: z2, pi: b2 } };
    }
  };
  var nt = class {
    constructor(t) {
      this.yi = { ki: 0, t: "#000", gi: 0, wi: 0 }, this.Ci = { Kt: "", yt: false, hi: true, mi: false, Ot: "", V: "#FFF", _i: false, bi: false }, this.Ti = { Kt: "", yt: false, hi: false, mi: true, Ot: "", V: "#FFF", _i: true, bi: true }, this.ft = true, this.Pi = new (t || it)(this.Ci, this.yi), this.Ri = new (t || it)(this.Ti, this.yi);
    }
    Kt() {
      return this.Di(), this.Ci.Kt;
    }
    ki() {
      return this.Di(), this.yi.ki;
    }
    bt() {
      this.ft = true;
    }
    At(t, i = false) {
      return Math.max(this.Pi.At(t, i), this.Ri.At(t, i));
    }
    Vi() {
      return this.yi.Si || 0;
    }
    Oi(t) {
      this.yi.Si = t;
    }
    Bi() {
      return this.Di(), this.Ci.yt || this.Ti.yt;
    }
    Ai() {
      return this.Di(), this.Ci.yt;
    }
    gt(t) {
      return this.Di(), this.Ci.hi = this.Ci.hi && t.W().ticksVisible, this.Ti.hi = this.Ti.hi && t.W().ticksVisible, this.Pi.J(this.Ci, this.yi), this.Ri.J(this.Ti, this.yi), this.Pi;
    }
    Ii() {
      return this.Di(), this.Pi.J(this.Ci, this.yi), this.Ri.J(this.Ti, this.yi), this.Ri;
    }
    Di() {
      this.ft && (this.Ci.hi = true, this.Ti.hi = false, this.zi(this.Ci, this.Ti, this.yi));
    }
  };
  var st = class extends nt {
    constructor(t, i, n) {
      super(), this.jt = t, this.Li = i, this.Ei = n;
    }
    zi(t, i, n) {
      if (t.yt = false, 2 === this.jt.W().mode) return;
      const s = this.jt.W().horzLine;
      if (!s.labelVisible) return;
      const e2 = this.Li.Ct();
      if (!this.jt.yt() || this.Li.Ni() || null === e2) return;
      const r2 = R(s.labelBackgroundColor);
      n.t = r2.t, t.V = r2.i;
      const h2 = 2 / 12 * this.Li.P();
      n.wi = h2, n.gi = h2;
      const l2 = this.Ei(this.Li);
      n.ki = l2.ki, t.Kt = this.Li.Fi(l2._t, e2), t.yt = true;
    }
  };
  var et = /[1-9]/g;
  var rt = class {
    constructor() {
      this.zt = null;
    }
    J(t) {
      this.zt = t;
    }
    X(t, i) {
      if (null === this.zt || false === this.zt.yt || 0 === this.zt.Kt.length) return;
      const n = t.useMediaCoordinateSpace((({ context: t2 }) => (t2.font = i.R, Math.round(i.Wi.xi(t2, b(this.zt).Kt, et)))));
      if (n <= 0) return;
      const s = i.ji, e2 = n + 2 * s, r2 = e2 / 2, h2 = this.zt.Hi;
      let l2 = this.zt.ki, a2 = Math.floor(l2 - r2) + 0.5;
      a2 < 0 ? (l2 += Math.abs(0 - a2), a2 = Math.floor(l2 - r2) + 0.5) : a2 + e2 > h2 && (l2 -= Math.abs(h2 - (a2 + e2)), a2 = Math.floor(l2 - r2) + 0.5);
      const o2 = a2 + e2, _2 = Math.ceil(0 + i.C + i.T + i.L + i.P + i.B);
      t.useBitmapCoordinateSpace((({ context: t2, horizontalPixelRatio: n2, verticalPixelRatio: s2 }) => {
        const e3 = b(this.zt);
        t2.fillStyle = e3.t;
        const r3 = Math.round(a2 * n2), h3 = Math.round(0 * s2), l3 = Math.round(o2 * n2), u2 = Math.round(_2 * s2), c2 = Math.round(2 * n2);
        if (t2.beginPath(), t2.moveTo(r3, h3), t2.lineTo(r3, u2 - c2), t2.arcTo(r3, u2, r3 + c2, u2, c2), t2.lineTo(l3 - c2, u2), t2.arcTo(l3, u2, l3, u2 - c2, c2), t2.lineTo(l3, h3), t2.fill(), e3.hi) {
          const r4 = Math.round(e3.ki * n2), l4 = h3, a3 = Math.round((l4 + i.T) * s2);
          t2.fillStyle = e3.V;
          const o3 = Math.max(1, Math.floor(n2)), _3 = Math.floor(0.5 * n2);
          t2.fillRect(r4 - _3, l4, o3, a3 - l4);
        }
      })), t.useMediaCoordinateSpace((({ context: t2 }) => {
        const n2 = b(this.zt), e3 = 0 + i.C + i.T + i.L + i.P / 2;
        t2.font = i.R, t2.textAlign = "left", t2.textBaseline = "middle", t2.fillStyle = n2.V;
        const r3 = i.Wi.Mi(t2, "Apr0");
        t2.translate(a2 + s, e3 + r3), t2.fillText(n2.Kt, 0, 0);
      }));
    }
  };
  var ht = class {
    constructor(t, i, n) {
      this.ft = true, this.Wt = new rt(), this.Ft = { yt: false, t: "#4c525e", V: "white", Kt: "", Hi: 0, ki: NaN, hi: true }, this.vt = t, this.$i = i, this.Ei = n;
    }
    bt() {
      this.ft = true;
    }
    gt() {
      return this.ft && (this.Mt(), this.ft = false), this.Wt.J(this.Ft), this.Wt;
    }
    Mt() {
      const t = this.Ft;
      if (t.yt = false, 2 === this.vt.W().mode) return;
      const i = this.vt.W().vertLine;
      if (!i.labelVisible) return;
      const n = this.$i.St();
      if (n.Ni()) return;
      t.Hi = n.Hi();
      const s = this.Ei();
      if (null === s) return;
      t.ki = s.ki;
      const e2 = n.Ui(this.vt.xt());
      t.Kt = n.qi(b(e2)), t.yt = true;
      const r2 = R(i.labelBackgroundColor);
      t.t = r2.t, t.V = r2.i, t.hi = n.W().ticksVisible;
    }
  };
  var lt = class {
    constructor() {
      this.Yi = null, this.Zi = 0;
    }
    Xi() {
      return this.Zi;
    }
    Ki(t) {
      this.Zi = t;
    }
    Dt() {
      return this.Yi;
    }
    Gi(t) {
      this.Yi = t;
    }
    Ji(t) {
      return [];
    }
    Qi() {
      return [];
    }
    yt() {
      return true;
    }
  };
  var at;
  !(function(t) {
    t[t.Normal = 0] = "Normal", t[t.Magnet = 1] = "Magnet", t[t.Hidden = 2] = "Hidden";
  })(at || (at = {}));
  var ot = class extends lt {
    constructor(t, i) {
      super(), this.tn = null, this.nn = NaN, this.sn = 0, this.en = true, this.rn = /* @__PURE__ */ new Map(), this.hn = false, this.ln = NaN, this.an = NaN, this._n = NaN, this.un = NaN, this.$i = t, this.cn = i, this.dn = new Y(t, this);
      this.fn = /* @__PURE__ */ ((t2, i2) => (n2) => {
        const s = i2(), e2 = t2();
        if (n2 === b(this.tn).vn()) return { _t: e2, ki: s };
        {
          const t3 = b(n2.Ct());
          return { _t: n2.pn(s, t3), ki: s };
        }
      })((() => this.nn), (() => this.an));
      const n = /* @__PURE__ */ ((t2, i2) => () => {
        const n2 = this.$i.St().mn(t2()), s = i2();
        return n2 && Number.isFinite(s) ? { ot: n2, ki: s } : null;
      })((() => this.sn), (() => this.Yt()));
      this.bn = new ht(this, t, n), this.wn = new X(this);
    }
    W() {
      return this.cn;
    }
    gn(t, i) {
      this._n = t, this.un = i;
    }
    Mn() {
      this._n = NaN, this.un = NaN;
    }
    xn() {
      return this._n;
    }
    Sn() {
      return this.un;
    }
    kn(t, i, n) {
      this.hn || (this.hn = true), this.en = true, this.yn(t, i, n);
    }
    xt() {
      return this.sn;
    }
    Yt() {
      return this.ln;
    }
    Zt() {
      return this.an;
    }
    yt() {
      return this.en;
    }
    Cn() {
      this.en = false, this.Tn(), this.nn = NaN, this.ln = NaN, this.an = NaN, this.tn = null, this.Mn();
    }
    Pn(t) {
      return null !== this.tn ? [this.wn, this.dn] : [];
    }
    Ut(t) {
      return t === this.tn && this.cn.horzLine.visible;
    }
    qt() {
      return this.cn.vertLine.visible;
    }
    Rn(t, i) {
      this.en && this.tn === t || this.rn.clear();
      const n = [];
      return this.tn === t && n.push(this.Dn(this.rn, i, this.fn)), n;
    }
    Qi() {
      return this.en ? [this.bn] : [];
    }
    Ht() {
      return this.tn;
    }
    Vn() {
      this.wn.bt(), this.rn.forEach(((t) => t.bt())), this.bn.bt(), this.dn.bt();
    }
    On(t) {
      return t && !t.vn().Ni() ? t.vn() : null;
    }
    yn(t, i, n) {
      this.Bn(t, i, n) && this.Vn();
    }
    Bn(t, i, n) {
      const s = this.ln, e2 = this.an, r2 = this.nn, h2 = this.sn, l2 = this.tn, a2 = this.On(n);
      this.sn = t, this.ln = isNaN(t) ? NaN : this.$i.St().It(t), this.tn = n;
      const o2 = null !== a2 ? a2.Ct() : null;
      return null !== a2 && null !== o2 ? (this.nn = i, this.an = a2.Rt(i, o2)) : (this.nn = NaN, this.an = NaN), s !== this.ln || e2 !== this.an || h2 !== this.sn || r2 !== this.nn || l2 !== this.tn;
    }
    Tn() {
      const t = this.$i.wt().map(((t2) => t2.In().An())).filter(L), i = 0 === t.length ? null : Math.max(...t);
      this.sn = null !== i ? i : NaN;
    }
    Dn(t, i, n) {
      let s = t.get(i);
      return void 0 === s && (s = new st(this, i, n), t.set(i, s)), s;
    }
  };
  function _t(t) {
    return "left" === t || "right" === t;
  }
  var ut = class _ut {
    constructor(t) {
      this.zn = /* @__PURE__ */ new Map(), this.Ln = [], this.En = t;
    }
    Nn(t, i) {
      const n = (function(t2, i2) {
        return void 0 === t2 ? i2 : { Fn: Math.max(t2.Fn, i2.Fn), Wn: t2.Wn || i2.Wn };
      })(this.zn.get(t), i);
      this.zn.set(t, n);
    }
    jn() {
      return this.En;
    }
    Hn(t) {
      const i = this.zn.get(t);
      return void 0 === i ? { Fn: this.En } : { Fn: Math.max(this.En, i.Fn), Wn: i.Wn };
    }
    $n() {
      this.Un(), this.Ln = [{ qn: 0 }];
    }
    Yn(t) {
      this.Un(), this.Ln = [{ qn: 1, Vt: t }];
    }
    Zn(t) {
      this.Xn(), this.Ln.push({ qn: 5, Vt: t });
    }
    Un() {
      this.Xn(), this.Ln.push({ qn: 6 });
    }
    Kn() {
      this.Un(), this.Ln = [{ qn: 4 }];
    }
    Gn(t) {
      this.Un(), this.Ln.push({ qn: 2, Vt: t });
    }
    Jn(t) {
      this.Un(), this.Ln.push({ qn: 3, Vt: t });
    }
    Qn() {
      return this.Ln;
    }
    ts(t) {
      for (const i of t.Ln) this.ns(i);
      this.En = Math.max(this.En, t.En), t.zn.forEach(((t2, i) => {
        this.Nn(i, t2);
      }));
    }
    static ss() {
      return new _ut(2);
    }
    static es() {
      return new _ut(3);
    }
    ns(t) {
      switch (t.qn) {
        case 0:
          this.$n();
          break;
        case 1:
          this.Yn(t.Vt);
          break;
        case 2:
          this.Gn(t.Vt);
          break;
        case 3:
          this.Jn(t.Vt);
          break;
        case 4:
          this.Kn();
          break;
        case 5:
          this.Zn(t.Vt);
          break;
        case 6:
          this.Xn();
      }
    }
    Xn() {
      const t = this.Ln.findIndex(((t2) => 5 === t2.qn));
      -1 !== t && this.Ln.splice(t, 1);
    }
  };
  var ct = ".";
  function dt(t, i) {
    if (!O(t)) return "n/a";
    if (!B(i)) throw new TypeError("invalid length");
    if (i < 0 || i > 16) throw new TypeError("invalid length");
    if (0 === i) return t.toString();
    return ("0000000000000000" + t.toString()).slice(-i);
  }
  var ft = class {
    constructor(t, i) {
      if (i || (i = 1), O(t) && B(t) || (t = 100), t < 0) throw new TypeError("invalid base");
      this.Li = t, this.rs = i, this.hs();
    }
    format(t) {
      const i = t < 0 ? "\u2212" : "";
      return t = Math.abs(t), i + this.ls(t);
    }
    hs() {
      if (this.os = 0, this.Li > 0 && this.rs > 0) {
        let t = this.Li;
        for (; t > 1; ) t /= 10, this.os++;
      }
    }
    ls(t) {
      const i = this.Li / this.rs;
      let n = Math.floor(t), s = "";
      const e2 = void 0 !== this.os ? this.os : NaN;
      if (i > 1) {
        let r2 = +(Math.round(t * i) - n * i).toFixed(this.os);
        r2 >= i && (r2 -= i, n += 1), s = ct + dt(+r2.toFixed(this.os) * this.rs, e2);
      } else n = Math.round(n * i) / i, e2 > 0 && (s = ct + dt(0, e2));
      return n.toFixed(0) + s;
    }
  };
  var vt = class extends ft {
    constructor(t = 100) {
      super(t);
    }
    format(t) {
      return `${super.format(t)}%`;
    }
  };
  var pt = class {
    constructor(t) {
      this._s = t;
    }
    format(t) {
      let i = "";
      return t < 0 && (i = "-", t = -t), t < 995 ? i + this.us(t) : t < 999995 ? i + this.us(t / 1e3) + "K" : t < 999999995 ? (t = 1e3 * Math.round(t / 1e3), i + this.us(t / 1e6) + "M") : (t = 1e6 * Math.round(t / 1e6), i + this.us(t / 1e9) + "B");
    }
    us(t) {
      let i;
      const n = Math.pow(10, this._s);
      return i = (t = Math.round(t * n) / n) >= 1e-15 && t < 1 ? t.toFixed(this._s).replace(/\.?0+$/, "") : String(t), i.replace(/(\.[1-9]*)0+$/, ((t2, i2) => i2));
    }
  };
  function mt(t, i, n, s, e2, r2, h2) {
    if (0 === i.length || s.from >= i.length || s.to <= 0) return;
    const { context: l2, horizontalPixelRatio: a2, verticalPixelRatio: o2 } = t, _2 = i[s.from];
    let u2 = r2(t, _2), c2 = _2;
    if (s.to - s.from < 2) {
      const i2 = e2 / 2;
      l2.beginPath();
      const n2 = { nt: _2.nt - i2, st: _2.st }, s2 = { nt: _2.nt + i2, st: _2.st };
      l2.moveTo(n2.nt * a2, n2.st * o2), l2.lineTo(s2.nt * a2, s2.st * o2), h2(t, u2, n2, s2);
    } else {
      const e3 = (i2, n2) => {
        h2(t, u2, c2, n2), l2.beginPath(), u2 = i2, c2 = n2;
      };
      let d2 = c2;
      l2.beginPath(), l2.moveTo(_2.nt * a2, _2.st * o2);
      for (let h3 = s.from + 1; h3 < s.to; ++h3) {
        d2 = i[h3];
        const s2 = r2(t, d2);
        switch (n) {
          case 0:
            l2.lineTo(d2.nt * a2, d2.st * o2);
            break;
          case 1:
            l2.lineTo(d2.nt * a2, i[h3 - 1].st * o2), s2 !== u2 && (e3(s2, d2), l2.lineTo(d2.nt * a2, i[h3 - 1].st * o2)), l2.lineTo(d2.nt * a2, d2.st * o2);
            break;
          case 2: {
            const [t2, n2] = Mt(i, h3 - 1, h3);
            l2.bezierCurveTo(t2.nt * a2, t2.st * o2, n2.nt * a2, n2.st * o2, d2.nt * a2, d2.st * o2);
            break;
          }
        }
        1 !== n && s2 !== u2 && (e3(s2, d2), l2.moveTo(d2.nt * a2, d2.st * o2));
      }
      (c2 !== d2 || c2 === d2 && 1 === n) && h2(t, u2, c2, d2);
    }
  }
  var bt = 6;
  function wt(t, i) {
    return { nt: t.nt - i.nt, st: t.st - i.st };
  }
  function gt(t, i) {
    return { nt: t.nt / i, st: t.st / i };
  }
  function Mt(t, i, n) {
    const s = Math.max(0, i - 1), e2 = Math.min(t.length - 1, n + 1);
    var r2, h2;
    return [(r2 = t[i], h2 = gt(wt(t[n], t[s]), bt), { nt: r2.nt + h2.nt, st: r2.st + h2.st }), wt(t[n], gt(wt(t[e2], t[i]), bt))];
  }
  function xt(t, i, n, s, e2) {
    const { context: r2, horizontalPixelRatio: h2, verticalPixelRatio: l2 } = i;
    r2.lineTo(e2.nt * h2, t * l2), r2.lineTo(s.nt * h2, t * l2), r2.closePath(), r2.fillStyle = n, r2.fill();
  }
  var St = class extends H {
    constructor() {
      super(...arguments), this.G = null;
    }
    J(t) {
      this.G = t;
    }
    K(t) {
      var i;
      if (null === this.G) return;
      const { it: n, tt: s, cs: e2, et: r2, Nt: h2, ds: l2 } = this.G, a2 = null !== (i = this.G.fs) && void 0 !== i ? i : this.G.vs ? 0 : t.mediaSize.height;
      if (null === s) return;
      const o2 = t.context;
      o2.lineCap = "butt", o2.lineJoin = "round", o2.lineWidth = r2, f(o2, h2), o2.lineWidth = 1, mt(t, n, l2, s, e2, this.ps.bind(this), xt.bind(null, a2));
    }
  };
  function kt(t, i, n) {
    return Math.min(Math.max(t, i), n);
  }
  function yt(t, i, n) {
    return i - t <= n;
  }
  function Ct(t) {
    const i = Math.ceil(t);
    return i % 2 == 0 ? i - 1 : i;
  }
  var Tt = class {
    bs(t, i) {
      const n = this.ws, { gs: s, Ms: e2, xs: r2, Ss: h2, ks: l2, fs: a2 } = i;
      if (void 0 === this.ys || void 0 === n || n.gs !== s || n.Ms !== e2 || n.xs !== r2 || n.Ss !== h2 || n.fs !== a2 || n.ks !== l2) {
        const n2 = t.context.createLinearGradient(0, 0, 0, l2);
        if (n2.addColorStop(0, s), null != a2) {
          const i2 = kt(a2 * t.verticalPixelRatio / l2, 0, 1);
          n2.addColorStop(i2, e2), n2.addColorStop(i2, r2);
        }
        n2.addColorStop(1, h2), this.ys = n2, this.ws = i;
      }
      return this.ys;
    }
  };
  var Pt = class extends St {
    constructor() {
      super(...arguments), this.Cs = new Tt();
    }
    ps(t, i) {
      return this.Cs.bs(t, { gs: i.Ts, Ms: "", xs: "", Ss: i.Ps, ks: t.bitmapSize.height });
    }
  };
  function Rt(t, i) {
    const n = t.context;
    n.strokeStyle = i, n.stroke();
  }
  var Dt = class extends H {
    constructor() {
      super(...arguments), this.G = null;
    }
    J(t) {
      this.G = t;
    }
    K(t) {
      if (null === this.G) return;
      const { it: i, tt: n, cs: s, ds: e2, et: r2, Nt: h2, Rs: l2 } = this.G;
      if (null === n) return;
      const a2 = t.context;
      a2.lineCap = "butt", a2.lineWidth = r2 * t.verticalPixelRatio, f(a2, h2), a2.lineJoin = "round";
      const o2 = this.Ds.bind(this);
      void 0 !== e2 && mt(t, i, e2, n, s, o2, Rt), l2 && (function(t2, i2, n2, s2, e3) {
        const { horizontalPixelRatio: r3, verticalPixelRatio: h3, context: l3 } = t2;
        let a3 = null;
        const o3 = Math.max(1, Math.floor(r3)) % 2 / 2, _2 = n2 * h3 + o3;
        for (let n3 = s2.to - 1; n3 >= s2.from; --n3) {
          const s3 = i2[n3];
          if (s3) {
            const i3 = e3(t2, s3);
            i3 !== a3 && (l3.beginPath(), null !== a3 && l3.fill(), l3.fillStyle = i3, a3 = i3);
            const n4 = Math.round(s3.nt * r3) + o3, u2 = s3.st * h3;
            l3.moveTo(n4, u2), l3.arc(n4, u2, _2, 0, 2 * Math.PI);
          }
        }
        l3.fill();
      })(t, i, l2, n, o2);
    }
  };
  var Vt = class extends Dt {
    Ds(t, i) {
      return i.lt;
    }
  };
  function Ot(t, i, n, s, e2 = 0, r2 = i.length) {
    let h2 = r2 - e2;
    for (; 0 < h2; ) {
      const r3 = h2 >> 1, l2 = e2 + r3;
      s(i[l2], n) === t ? (e2 = l2 + 1, h2 -= r3 + 1) : h2 = r3;
    }
    return e2;
  }
  var Bt = Ot.bind(null, true);
  var At = Ot.bind(null, false);
  function It(t, i) {
    return t.ot < i;
  }
  function zt(t, i) {
    return i < t.ot;
  }
  function Lt(t, i, n) {
    const s = i.Vs(), e2 = i.ui(), r2 = Bt(t, s, It), h2 = At(t, e2, zt);
    if (!n) return { from: r2, to: h2 };
    let l2 = r2, a2 = h2;
    return r2 > 0 && r2 < t.length && t[r2].ot >= s && (l2 = r2 - 1), h2 > 0 && h2 < t.length && t[h2 - 1].ot <= e2 && (a2 = h2 + 1), { from: l2, to: a2 };
  }
  var Et = class {
    constructor(t, i, n) {
      this.Os = true, this.Bs = true, this.As = true, this.Is = [], this.zs = null, this.Ls = t, this.Es = i, this.Ns = n;
    }
    bt(t) {
      this.Os = true, "data" === t && (this.Bs = true), "options" === t && (this.As = true);
    }
    gt() {
      return this.Ls.yt() ? (this.Fs(), null === this.zs ? null : this.Ws) : null;
    }
    js() {
      this.Is = this.Is.map(((t) => Object.assign(Object.assign({}, t), this.Ls.$s().Hs(t.ot))));
    }
    Us() {
      this.zs = null;
    }
    Fs() {
      this.Bs && (this.qs(), this.Bs = false), this.As && (this.js(), this.As = false), this.Os && (this.Ys(), this.Os = false);
    }
    Ys() {
      const t = this.Ls.Dt(), i = this.Es.St();
      if (this.Us(), i.Ni() || t.Ni()) return;
      const n = i.Zs();
      if (null === n) return;
      if (0 === this.Ls.In().Xs()) return;
      const s = this.Ls.Ct();
      null !== s && (this.zs = Lt(this.Is, n, this.Ns), this.Ks(t, i, s.Vt), this.Gs());
    }
  };
  var Nt = class extends Et {
    constructor(t, i) {
      super(t, i, true);
    }
    Ks(t, i, n) {
      i.Js(this.Is, E(this.zs)), t.Qs(this.Is, n, E(this.zs));
    }
    te(t, i) {
      return { ot: t, _t: i, nt: NaN, st: NaN };
    }
    qs() {
      const t = this.Ls.$s();
      this.Is = this.Ls.In().ie().map(((i) => {
        const n = i.Vt[3];
        return this.ne(i.se, n, t);
      }));
    }
  };
  var Ft = class extends Nt {
    constructor(t, i) {
      super(t, i), this.Ws = new j(), this.ee = new Pt(), this.re = new Vt(), this.Ws.Z([this.ee, this.re]);
    }
    ne(t, i, n) {
      return Object.assign(Object.assign({}, this.te(t, i)), n.Hs(t));
    }
    Gs() {
      const t = this.Ls.W();
      this.ee.J({ ds: t.lineType, it: this.Is, Nt: t.lineStyle, et: t.lineWidth, fs: null, vs: t.invertFilledArea, tt: this.zs, cs: this.Es.St().he() }), this.re.J({ ds: t.lineVisible ? t.lineType : void 0, it: this.Is, Nt: t.lineStyle, et: t.lineWidth, tt: this.zs, cs: this.Es.St().he(), Rs: t.pointMarkersVisible ? t.pointMarkersRadius || t.lineWidth / 2 + 2 : void 0 });
    }
  };
  var Wt = class extends H {
    constructor() {
      super(...arguments), this.zt = null, this.le = 0, this.ae = 0;
    }
    J(t) {
      this.zt = t;
    }
    K({ context: t, horizontalPixelRatio: i, verticalPixelRatio: n }) {
      if (null === this.zt || 0 === this.zt.In.length || null === this.zt.tt) return;
      if (this.le = this.oe(i), this.le >= 2) {
        Math.max(1, Math.floor(i)) % 2 != this.le % 2 && this.le--;
      }
      this.ae = this.zt._e ? Math.min(this.le, Math.floor(i)) : this.le;
      let s = null;
      const e2 = this.ae <= this.le && this.zt.he >= Math.floor(1.5 * i);
      for (let r2 = this.zt.tt.from; r2 < this.zt.tt.to; ++r2) {
        const h2 = this.zt.In[r2];
        s !== h2.ue && (t.fillStyle = h2.ue, s = h2.ue);
        const l2 = Math.floor(0.5 * this.ae), a2 = Math.round(h2.nt * i), o2 = a2 - l2, _2 = this.ae, u2 = o2 + _2 - 1, c2 = Math.min(h2.ce, h2.de), d2 = Math.max(h2.ce, h2.de), f2 = Math.round(c2 * n) - l2, v2 = Math.round(d2 * n) + l2, p2 = Math.max(v2 - f2, this.ae);
        t.fillRect(o2, f2, _2, p2);
        const m2 = Math.ceil(1.5 * this.le);
        if (e2) {
          if (this.zt.fe) {
            const i3 = a2 - m2;
            let s3 = Math.max(f2, Math.round(h2.ve * n) - l2), e4 = s3 + _2 - 1;
            e4 > f2 + p2 - 1 && (e4 = f2 + p2 - 1, s3 = e4 - _2 + 1), t.fillRect(i3, s3, o2 - i3, e4 - s3 + 1);
          }
          const i2 = a2 + m2;
          let s2 = Math.max(f2, Math.round(h2.pe * n) - l2), e3 = s2 + _2 - 1;
          e3 > f2 + p2 - 1 && (e3 = f2 + p2 - 1, s2 = e3 - _2 + 1), t.fillRect(u2 + 1, s2, i2 - u2, e3 - s2 + 1);
        }
      }
    }
    oe(t) {
      const i = Math.floor(t);
      return Math.max(i, Math.floor((function(t2, i2) {
        return Math.floor(0.3 * t2 * i2);
      })(b(this.zt).he, t)));
    }
  };
  var jt = class extends Et {
    constructor(t, i) {
      super(t, i, false);
    }
    Ks(t, i, n) {
      i.Js(this.Is, E(this.zs)), t.me(this.Is, n, E(this.zs));
    }
    be(t, i, n) {
      return { ot: t, we: i.Vt[0], ge: i.Vt[1], Me: i.Vt[2], xe: i.Vt[3], nt: NaN, ve: NaN, ce: NaN, de: NaN, pe: NaN };
    }
    qs() {
      const t = this.Ls.$s();
      this.Is = this.Ls.In().ie().map(((i) => this.ne(i.se, i, t)));
    }
  };
  var Ht = class extends jt {
    constructor() {
      super(...arguments), this.Ws = new Wt();
    }
    ne(t, i, n) {
      return Object.assign(Object.assign({}, this.be(t, i, n)), n.Hs(t));
    }
    Gs() {
      const t = this.Ls.W();
      this.Ws.J({ In: this.Is, he: this.Es.St().he(), fe: t.openVisible, _e: t.thinBars, tt: this.zs });
    }
  };
  var $t = class extends St {
    constructor() {
      super(...arguments), this.Cs = new Tt();
    }
    ps(t, i) {
      const n = this.G;
      return this.Cs.bs(t, { gs: i.Se, Ms: i.ke, xs: i.ye, Ss: i.Ce, ks: t.bitmapSize.height, fs: n.fs });
    }
  };
  var Ut = class extends Dt {
    constructor() {
      super(...arguments), this.Te = new Tt();
    }
    Ds(t, i) {
      const n = this.G;
      return this.Te.bs(t, { gs: i.Pe, Ms: i.Pe, xs: i.Re, Ss: i.Re, ks: t.bitmapSize.height, fs: n.fs });
    }
  };
  var qt = class extends Nt {
    constructor(t, i) {
      super(t, i), this.Ws = new j(), this.De = new $t(), this.Ve = new Ut(), this.Ws.Z([this.De, this.Ve]);
    }
    ne(t, i, n) {
      return Object.assign(Object.assign({}, this.te(t, i)), n.Hs(t));
    }
    Gs() {
      const t = this.Ls.Ct();
      if (null === t) return;
      const i = this.Ls.W(), n = this.Ls.Dt().Rt(i.baseValue.price, t.Vt), s = this.Es.St().he();
      this.De.J({ it: this.Is, et: i.lineWidth, Nt: i.lineStyle, ds: i.lineType, fs: n, vs: false, tt: this.zs, cs: s }), this.Ve.J({ it: this.Is, et: i.lineWidth, Nt: i.lineStyle, ds: i.lineVisible ? i.lineType : void 0, Rs: i.pointMarkersVisible ? i.pointMarkersRadius || i.lineWidth / 2 + 2 : void 0, fs: n, tt: this.zs, cs: s });
    }
  };
  var Yt = class extends H {
    constructor() {
      super(...arguments), this.zt = null, this.le = 0;
    }
    J(t) {
      this.zt = t;
    }
    K(t) {
      if (null === this.zt || 0 === this.zt.In.length || null === this.zt.tt) return;
      const { horizontalPixelRatio: i } = t;
      if (this.le = (function(t2, i2) {
        if (t2 >= 2.5 && t2 <= 4) return Math.floor(3 * i2);
        const n2 = 1 - 0.2 * Math.atan(Math.max(4, t2) - 4) / (0.5 * Math.PI), s2 = Math.floor(t2 * n2 * i2), e2 = Math.floor(t2 * i2), r2 = Math.min(s2, e2);
        return Math.max(Math.floor(i2), r2);
      })(this.zt.he, i), this.le >= 2) {
        Math.floor(i) % 2 != this.le % 2 && this.le--;
      }
      const n = this.zt.In;
      this.zt.Oe && this.Be(t, n, this.zt.tt), this.zt._i && this.Ae(t, n, this.zt.tt);
      const s = this.Ie(i);
      (!this.zt._i || this.le > 2 * s) && this.ze(t, n, this.zt.tt);
    }
    Be(t, i, n) {
      if (null === this.zt) return;
      const { context: s, horizontalPixelRatio: e2, verticalPixelRatio: r2 } = t;
      let h2 = "", l2 = Math.min(Math.floor(e2), Math.floor(this.zt.he * e2));
      l2 = Math.max(Math.floor(e2), Math.min(l2, this.le));
      const a2 = Math.floor(0.5 * l2);
      let o2 = null;
      for (let t2 = n.from; t2 < n.to; t2++) {
        const n2 = i[t2];
        n2.Le !== h2 && (s.fillStyle = n2.Le, h2 = n2.Le);
        const _2 = Math.round(Math.min(n2.ve, n2.pe) * r2), u2 = Math.round(Math.max(n2.ve, n2.pe) * r2), c2 = Math.round(n2.ce * r2), d2 = Math.round(n2.de * r2);
        let f2 = Math.round(e2 * n2.nt) - a2;
        const v2 = f2 + l2 - 1;
        null !== o2 && (f2 = Math.max(o2 + 1, f2), f2 = Math.min(f2, v2));
        const p2 = v2 - f2 + 1;
        s.fillRect(f2, c2, p2, _2 - c2), s.fillRect(f2, u2 + 1, p2, d2 - u2), o2 = v2;
      }
    }
    Ie(t) {
      let i = Math.floor(1 * t);
      this.le <= 2 * i && (i = Math.floor(0.5 * (this.le - 1)));
      const n = Math.max(Math.floor(t), i);
      return this.le <= 2 * n ? Math.max(Math.floor(t), Math.floor(1 * t)) : n;
    }
    Ae(t, i, n) {
      if (null === this.zt) return;
      const { context: s, horizontalPixelRatio: e2, verticalPixelRatio: r2 } = t;
      let h2 = "";
      const l2 = this.Ie(e2);
      let a2 = null;
      for (let t2 = n.from; t2 < n.to; t2++) {
        const n2 = i[t2];
        n2.Ee !== h2 && (s.fillStyle = n2.Ee, h2 = n2.Ee);
        let o2 = Math.round(n2.nt * e2) - Math.floor(0.5 * this.le);
        const _2 = o2 + this.le - 1, u2 = Math.round(Math.min(n2.ve, n2.pe) * r2), c2 = Math.round(Math.max(n2.ve, n2.pe) * r2);
        if (null !== a2 && (o2 = Math.max(a2 + 1, o2), o2 = Math.min(o2, _2)), this.zt.he * e2 > 2 * l2) K(s, o2, u2, _2 - o2 + 1, c2 - u2 + 1, l2);
        else {
          const t3 = _2 - o2 + 1;
          s.fillRect(o2, u2, t3, c2 - u2 + 1);
        }
        a2 = _2;
      }
    }
    ze(t, i, n) {
      if (null === this.zt) return;
      const { context: s, horizontalPixelRatio: e2, verticalPixelRatio: r2 } = t;
      let h2 = "";
      const l2 = this.Ie(e2);
      for (let t2 = n.from; t2 < n.to; t2++) {
        const n2 = i[t2];
        let a2 = Math.round(Math.min(n2.ve, n2.pe) * r2), o2 = Math.round(Math.max(n2.ve, n2.pe) * r2), _2 = Math.round(n2.nt * e2) - Math.floor(0.5 * this.le), u2 = _2 + this.le - 1;
        if (n2.ue !== h2) {
          const t3 = n2.ue;
          s.fillStyle = t3, h2 = t3;
        }
        this.zt._i && (_2 += l2, a2 += l2, u2 -= l2, o2 -= l2), a2 > o2 || s.fillRect(_2, a2, u2 - _2 + 1, o2 - a2 + 1);
      }
    }
  };
  var Zt = class extends jt {
    constructor() {
      super(...arguments), this.Ws = new Yt();
    }
    ne(t, i, n) {
      return Object.assign(Object.assign({}, this.be(t, i, n)), n.Hs(t));
    }
    Gs() {
      const t = this.Ls.W();
      this.Ws.J({ In: this.Is, he: this.Es.St().he(), Oe: t.wickVisible, _i: t.borderVisible, tt: this.zs });
    }
  };
  var Xt = class {
    constructor(t, i) {
      this.Ne = t, this.Li = i;
    }
    X(t, i, n) {
      this.Ne.draw(t, this.Li, i, n);
    }
  };
  var Kt = class extends Et {
    constructor(t, i, n) {
      super(t, i, false), this.wn = n, this.Ws = new Xt(this.wn.renderer(), ((i2) => {
        const n2 = t.Ct();
        return null === n2 ? null : t.Dt().Rt(i2, n2.Vt);
      }));
    }
    Fe(t) {
      return this.wn.priceValueBuilder(t);
    }
    We(t) {
      return this.wn.isWhitespace(t);
    }
    qs() {
      const t = this.Ls.$s();
      this.Is = this.Ls.In().ie().map(((i) => Object.assign(Object.assign({ ot: i.se, nt: NaN }, t.Hs(i.se)), { je: i.He })));
    }
    Ks(t, i) {
      i.Js(this.Is, E(this.zs));
    }
    Gs() {
      this.wn.update({ bars: this.Is.map(Gt), barSpacing: this.Es.St().he(), visibleRange: this.zs }, this.Ls.W());
    }
  };
  function Gt(t) {
    return { x: t.nt, time: t.ot, originalData: t.je, barColor: t.ue };
  }
  var Jt = class extends H {
    constructor() {
      super(...arguments), this.zt = null, this.$e = [];
    }
    J(t) {
      this.zt = t, this.$e = [];
    }
    K({ context: t, horizontalPixelRatio: i, verticalPixelRatio: n }) {
      if (null === this.zt || 0 === this.zt.it.length || null === this.zt.tt) return;
      this.$e.length || this.Ue(i);
      const s = Math.max(1, Math.floor(n)), e2 = Math.round(this.zt.qe * n) - Math.floor(s / 2), r2 = e2 + s;
      for (let i2 = this.zt.tt.from; i2 < this.zt.tt.to; i2++) {
        const h2 = this.zt.it[i2], l2 = this.$e[i2 - this.zt.tt.from], a2 = Math.round(h2.st * n);
        let o2, _2;
        t.fillStyle = h2.ue, a2 <= e2 ? (o2 = a2, _2 = r2) : (o2 = e2, _2 = a2 - Math.floor(s / 2) + s), t.fillRect(l2.Vs, o2, l2.ui - l2.Vs + 1, _2 - o2);
      }
    }
    Ue(t) {
      if (null === this.zt || 0 === this.zt.it.length || null === this.zt.tt) return void (this.$e = []);
      const i = Math.ceil(this.zt.he * t) <= 1 ? 0 : Math.max(1, Math.floor(t)), n = Math.round(this.zt.he * t) - i;
      this.$e = new Array(this.zt.tt.to - this.zt.tt.from);
      for (let i2 = this.zt.tt.from; i2 < this.zt.tt.to; i2++) {
        const s2 = this.zt.it[i2], e2 = Math.round(s2.nt * t);
        let r2, h2;
        if (n % 2) {
          const t2 = (n - 1) / 2;
          r2 = e2 - t2, h2 = e2 + t2;
        } else {
          const t2 = n / 2;
          r2 = e2 - t2, h2 = e2 + t2 - 1;
        }
        this.$e[i2 - this.zt.tt.from] = { Vs: r2, ui: h2, Ye: e2, Ze: s2.nt * t, ot: s2.ot };
      }
      for (let t2 = this.zt.tt.from + 1; t2 < this.zt.tt.to; t2++) {
        const n2 = this.$e[t2 - this.zt.tt.from], s2 = this.$e[t2 - this.zt.tt.from - 1];
        n2.ot === s2.ot + 1 && (n2.Vs - s2.ui !== i + 1 && (s2.Ye > s2.Ze ? s2.ui = n2.Vs - i - 1 : n2.Vs = s2.ui + i + 1));
      }
      let s = Math.ceil(this.zt.he * t);
      for (let t2 = this.zt.tt.from; t2 < this.zt.tt.to; t2++) {
        const i2 = this.$e[t2 - this.zt.tt.from];
        i2.ui < i2.Vs && (i2.ui = i2.Vs);
        const n2 = i2.ui - i2.Vs + 1;
        s = Math.min(n2, s);
      }
      if (i > 0 && s < 4) for (let t2 = this.zt.tt.from; t2 < this.zt.tt.to; t2++) {
        const i2 = this.$e[t2 - this.zt.tt.from];
        i2.ui - i2.Vs + 1 > s && (i2.Ye > i2.Ze ? i2.ui -= 1 : i2.Vs += 1);
      }
    }
  };
  var Qt = class extends Nt {
    constructor() {
      super(...arguments), this.Ws = new Jt();
    }
    ne(t, i, n) {
      return Object.assign(Object.assign({}, this.te(t, i)), n.Hs(t));
    }
    Gs() {
      const t = { it: this.Is, he: this.Es.St().he(), tt: this.zs, qe: this.Ls.Dt().Rt(this.Ls.W().base, b(this.Ls.Ct()).Vt) };
      this.Ws.J(t);
    }
  };
  var ti = class extends Nt {
    constructor() {
      super(...arguments), this.Ws = new Vt();
    }
    ne(t, i, n) {
      return Object.assign(Object.assign({}, this.te(t, i)), n.Hs(t));
    }
    Gs() {
      const t = this.Ls.W(), i = { it: this.Is, Nt: t.lineStyle, ds: t.lineVisible ? t.lineType : void 0, et: t.lineWidth, Rs: t.pointMarkersVisible ? t.pointMarkersRadius || t.lineWidth / 2 + 2 : void 0, tt: this.zs, cs: this.Es.St().he() };
      this.Ws.J(i);
    }
  };
  var ii = /[2-9]/g;
  var ni = class {
    constructor(t = 50) {
      this.Xe = 0, this.Ke = 1, this.Ge = 1, this.Je = {}, this.Qe = /* @__PURE__ */ new Map(), this.tr = t;
    }
    ir() {
      this.Xe = 0, this.Qe.clear(), this.Ke = 1, this.Ge = 1, this.Je = {};
    }
    xi(t, i, n) {
      return this.nr(t, i, n).width;
    }
    Mi(t, i, n) {
      const s = this.nr(t, i, n);
      return ((s.actualBoundingBoxAscent || 0) - (s.actualBoundingBoxDescent || 0)) / 2;
    }
    nr(t, i, n) {
      const s = n || ii, e2 = String(i).replace(s, "0");
      if (this.Qe.has(e2)) return m(this.Qe.get(e2)).sr;
      if (this.Xe === this.tr) {
        const t2 = this.Je[this.Ge];
        delete this.Je[this.Ge], this.Qe.delete(t2), this.Ge++, this.Xe--;
      }
      t.save(), t.textBaseline = "middle";
      const r2 = t.measureText(e2);
      return t.restore(), 0 === r2.width && i.length || (this.Qe.set(e2, { sr: r2, er: this.Ke }), this.Je[this.Ke] = e2, this.Xe++, this.Ke++), r2;
    }
  };
  var si = class {
    constructor(t) {
      this.rr = null, this.k = null, this.hr = "right", this.lr = t;
    }
    ar(t, i, n) {
      this.rr = t, this.k = i, this.hr = n;
    }
    X(t) {
      null !== this.k && null !== this.rr && this.rr.X(t, this.k, this.lr, this.hr);
    }
  };
  var ei = class {
    constructor(t, i, n) {
      this._r = t, this.lr = new ni(50), this.ur = i, this.F = n, this.j = -1, this.Wt = new si(this.lr);
    }
    gt() {
      const t = this.F.cr(this.ur);
      if (null === t) return null;
      const i = t.dr(this.ur) ? t.vr() : this.ur.Dt();
      if (null === i) return null;
      const n = t.pr(i);
      if ("overlay" === n) return null;
      const s = this.F.mr();
      return s.P !== this.j && (this.j = s.P, this.lr.ir()), this.Wt.ar(this._r.Ii(), s, n), this.Wt;
    }
  };
  var ri = class extends H {
    constructor() {
      super(...arguments), this.zt = null;
    }
    J(t) {
      this.zt = t;
    }
    br(t, i) {
      var n;
      if (!(null === (n = this.zt) || void 0 === n ? void 0 : n.yt)) return null;
      const { st: s, et: e2, wr: r2 } = this.zt;
      return i >= s - e2 - 7 && i <= s + e2 + 7 ? { gr: this.zt, wr: r2 } : null;
    }
    K({ context: t, bitmapSize: i, horizontalPixelRatio: n, verticalPixelRatio: s }) {
      if (null === this.zt) return;
      if (false === this.zt.yt) return;
      const e2 = Math.round(this.zt.st * s);
      e2 < 0 || e2 > i.height || (t.lineCap = "butt", t.strokeStyle = this.zt.V, t.lineWidth = Math.floor(this.zt.et * n), f(t, this.zt.Nt), v(t, e2, 0, i.width));
    }
  };
  var hi = class {
    constructor(t) {
      this.Mr = { st: 0, V: "rgba(0, 0, 0, 0)", et: 1, Nt: 0, yt: false }, this.Sr = new ri(), this.ft = true, this.Ls = t, this.Es = t.$t(), this.Sr.J(this.Mr);
    }
    bt() {
      this.ft = true;
    }
    gt() {
      return this.Ls.yt() ? (this.ft && (this.kr(), this.ft = false), this.Sr) : null;
    }
  };
  var li = class extends hi {
    constructor(t) {
      super(t);
    }
    kr() {
      this.Mr.yt = false;
      const t = this.Ls.Dt(), i = t.yr().yr;
      if (2 !== i && 3 !== i) return;
      const n = this.Ls.W();
      if (!n.baseLineVisible || !this.Ls.yt()) return;
      const s = this.Ls.Ct();
      null !== s && (this.Mr.yt = true, this.Mr.st = t.Rt(s.Vt, s.Vt), this.Mr.V = n.baseLineColor, this.Mr.et = n.baseLineWidth, this.Mr.Nt = n.baseLineStyle);
    }
  };
  var ai = class extends H {
    constructor() {
      super(...arguments), this.zt = null;
    }
    J(t) {
      this.zt = t;
    }
    He() {
      return this.zt;
    }
    K({ context: t, horizontalPixelRatio: i, verticalPixelRatio: n }) {
      const s = this.zt;
      if (null === s) return;
      const e2 = Math.max(1, Math.floor(i)), r2 = e2 % 2 / 2, h2 = Math.round(s.Ze.x * i) + r2, l2 = s.Ze.y * n;
      t.fillStyle = s.Cr, t.beginPath();
      const a2 = Math.max(2, 1.5 * s.Tr) * i;
      t.arc(h2, l2, a2, 0, 2 * Math.PI, false), t.fill(), t.fillStyle = s.Pr, t.beginPath(), t.arc(h2, l2, s.ht * i, 0, 2 * Math.PI, false), t.fill(), t.lineWidth = e2, t.strokeStyle = s.Rr, t.beginPath(), t.arc(h2, l2, s.ht * i + e2 / 2, 0, 2 * Math.PI, false), t.stroke();
    }
  };
  var oi = [{ Dr: 0, Vr: 0.25, Or: 4, Br: 10, Ar: 0.25, Ir: 0, zr: 0.4, Lr: 0.8 }, { Dr: 0.25, Vr: 0.525, Or: 10, Br: 14, Ar: 0, Ir: 0, zr: 0.8, Lr: 0 }, { Dr: 0.525, Vr: 1, Or: 14, Br: 14, Ar: 0, Ir: 0, zr: 0, Lr: 0 }];
  function _i(t, i, n, s) {
    return (function(t2, i2) {
      if ("transparent" === t2) return t2;
      const n2 = T(t2), s2 = n2[3];
      return `rgba(${n2[0]}, ${n2[1]}, ${n2[2]}, ${i2 * s2})`;
    })(t, n + (s - n) * i);
  }
  function ui(t, i) {
    const n = t % 2600 / 2600;
    let s;
    for (const t2 of oi) if (n >= t2.Dr && n <= t2.Vr) {
      s = t2;
      break;
    }
    p(void 0 !== s, "Last price animation internal logic error");
    const e2 = (n - s.Dr) / (s.Vr - s.Dr);
    return { Pr: _i(i, e2, s.Ar, s.Ir), Rr: _i(i, e2, s.zr, s.Lr), ht: (r2 = e2, h2 = s.Or, l2 = s.Br, h2 + (l2 - h2) * r2) };
    var r2, h2, l2;
  }
  var ci = class {
    constructor(t) {
      this.Wt = new ai(), this.ft = true, this.Er = true, this.Nr = performance.now(), this.Fr = this.Nr - 1, this.Wr = t;
    }
    jr() {
      this.Fr = this.Nr - 1, this.bt();
    }
    Hr() {
      if (this.bt(), 2 === this.Wr.W().lastPriceAnimation) {
        const t = performance.now(), i = this.Fr - t;
        if (i > 0) return void (i < 650 && (this.Fr += 2600));
        this.Nr = t, this.Fr = t + 2600;
      }
    }
    bt() {
      this.ft = true;
    }
    $r() {
      this.Er = true;
    }
    yt() {
      return 0 !== this.Wr.W().lastPriceAnimation;
    }
    Ur() {
      switch (this.Wr.W().lastPriceAnimation) {
        case 0:
          return false;
        case 1:
          return true;
        case 2:
          return performance.now() <= this.Fr;
      }
    }
    gt() {
      return this.ft ? (this.Mt(), this.ft = false, this.Er = false) : this.Er && (this.qr(), this.Er = false), this.Wt;
    }
    Mt() {
      this.Wt.J(null);
      const t = this.Wr.$t().St(), i = t.Zs(), n = this.Wr.Ct();
      if (null === i || null === n) return;
      const s = this.Wr.Yr(true);
      if (s.Zr || !i.Xr(s.se)) return;
      const e2 = { x: t.It(s.se), y: this.Wr.Dt().Rt(s._t, n.Vt) }, r2 = s.V, h2 = this.Wr.W().lineWidth, l2 = ui(this.Kr(), r2);
      this.Wt.J({ Cr: r2, Tr: h2, Pr: l2.Pr, Rr: l2.Rr, ht: l2.ht, Ze: e2 });
    }
    qr() {
      const t = this.Wt.He();
      if (null !== t) {
        const i = ui(this.Kr(), t.Cr);
        t.Pr = i.Pr, t.Rr = i.Rr, t.ht = i.ht;
      }
    }
    Kr() {
      return this.Ur() ? performance.now() - this.Nr : 2599;
    }
  };
  function di(t, i) {
    return Ct(Math.min(Math.max(t, 12), 30) * i);
  }
  function fi(t, i) {
    switch (t) {
      case "arrowDown":
      case "arrowUp":
        return di(i, 1);
      case "circle":
        return di(i, 0.8);
      case "square":
        return di(i, 0.7);
    }
  }
  function vi(t) {
    return (function(t2) {
      const i = Math.ceil(t2);
      return i % 2 != 0 ? i - 1 : i;
    })(di(t, 1));
  }
  function pi(t) {
    return Math.max(di(t, 0.1), 3);
  }
  function mi(t, i, n) {
    return i ? t : n ? Math.ceil(t / 2) : 0;
  }
  function bi(t, i, n, s, e2) {
    const r2 = fi("square", n), h2 = (r2 - 1) / 2, l2 = t - h2, a2 = i - h2;
    return s >= l2 && s <= l2 + r2 && e2 >= a2 && e2 <= a2 + r2;
  }
  function wi(t, i, n, s) {
    const e2 = (fi("arrowUp", s) - 1) / 2 * n.Gr, r2 = (Ct(s / 2) - 1) / 2 * n.Gr;
    i.beginPath(), t ? (i.moveTo(n.nt - e2, n.st), i.lineTo(n.nt, n.st - e2), i.lineTo(n.nt + e2, n.st), i.lineTo(n.nt + r2, n.st), i.lineTo(n.nt + r2, n.st + e2), i.lineTo(n.nt - r2, n.st + e2), i.lineTo(n.nt - r2, n.st)) : (i.moveTo(n.nt - e2, n.st), i.lineTo(n.nt, n.st + e2), i.lineTo(n.nt + e2, n.st), i.lineTo(n.nt + r2, n.st), i.lineTo(n.nt + r2, n.st - e2), i.lineTo(n.nt - r2, n.st - e2), i.lineTo(n.nt - r2, n.st)), i.fill();
  }
  function gi(t, i, n, s, e2, r2) {
    return bi(i, n, s, e2, r2);
  }
  var Mi = class extends H {
    constructor() {
      super(...arguments), this.zt = null, this.lr = new ni(), this.j = -1, this.H = "", this.Jr = "";
    }
    J(t) {
      this.zt = t;
    }
    ar(t, i) {
      this.j === t && this.H === i || (this.j = t, this.H = i, this.Jr = F(t, i), this.lr.ir());
    }
    br(t, i) {
      if (null === this.zt || null === this.zt.tt) return null;
      for (let n = this.zt.tt.from; n < this.zt.tt.to; n++) {
        const s = this.zt.it[n];
        if (Si(s, t, i)) return { gr: s.Qr, wr: s.wr };
      }
      return null;
    }
    K({ context: t, horizontalPixelRatio: i, verticalPixelRatio: n }, s, e2) {
      if (null !== this.zt && null !== this.zt.tt) {
        t.textBaseline = "middle", t.font = this.Jr;
        for (let s2 = this.zt.tt.from; s2 < this.zt.tt.to; s2++) {
          const e3 = this.zt.it[s2];
          void 0 !== e3.Kt && (e3.Kt.Hi = this.lr.xi(t, e3.Kt.th), e3.Kt.At = this.j, e3.Kt.nt = e3.nt - e3.Kt.Hi / 2), xi(e3, t, i, n);
        }
      }
    }
  };
  function xi(t, i, n, s) {
    i.fillStyle = t.V, void 0 !== t.Kt && (function(t2, i2, n2, s2, e2, r2) {
      t2.save(), t2.scale(e2, r2), t2.fillText(i2, n2, s2), t2.restore();
    })(i, t.Kt.th, t.Kt.nt, t.Kt.st, n, s), (function(t2, i2, n2) {
      if (0 === t2.Xs) return;
      switch (t2.ih) {
        case "arrowDown":
          return void wi(false, i2, n2, t2.Xs);
        case "arrowUp":
          return void wi(true, i2, n2, t2.Xs);
        case "circle":
          return void (function(t3, i3, n3) {
            const s2 = (fi("circle", n3) - 1) / 2;
            t3.beginPath(), t3.arc(i3.nt, i3.st, s2 * i3.Gr, 0, 2 * Math.PI, false), t3.fill();
          })(i2, n2, t2.Xs);
        case "square":
          return void (function(t3, i3, n3) {
            const s2 = fi("square", n3), e2 = (s2 - 1) * i3.Gr / 2, r2 = i3.nt - e2, h2 = i3.st - e2;
            t3.fillRect(r2, h2, s2 * i3.Gr, s2 * i3.Gr);
          })(i2, n2, t2.Xs);
      }
      t2.ih;
    })(t, i, (function(t2, i2, n2) {
      const s2 = Math.max(1, Math.floor(i2)) % 2 / 2;
      return { nt: Math.round(t2.nt * i2) + s2, st: t2.st * n2, Gr: i2 };
    })(t, n, s));
  }
  function Si(t, i, n) {
    return !(void 0 === t.Kt || !(function(t2, i2, n2, s, e2, r2) {
      const h2 = s / 2;
      return e2 >= t2 && e2 <= t2 + n2 && r2 >= i2 - h2 && r2 <= i2 + h2;
    })(t.Kt.nt, t.Kt.st, t.Kt.Hi, t.Kt.At, i, n)) || (function(t2, i2, n2) {
      if (0 === t2.Xs) return false;
      switch (t2.ih) {
        case "arrowDown":
        case "arrowUp":
          return gi(0, t2.nt, t2.st, t2.Xs, i2, n2);
        case "circle":
          return (function(t3, i3, n3, s, e2) {
            const r2 = 2 + fi("circle", n3) / 2, h2 = t3 - s, l2 = i3 - e2;
            return Math.sqrt(h2 * h2 + l2 * l2) <= r2;
          })(t2.nt, t2.st, t2.Xs, i2, n2);
        case "square":
          return bi(t2.nt, t2.st, t2.Xs, i2, n2);
      }
    })(t, i, n);
  }
  function ki(t, i, n, s, e2, r2, h2, l2, a2) {
    const o2 = O(n) ? n : n.xe, _2 = O(n) ? n : n.ge, u2 = O(n) ? n : n.Me, c2 = O(i.size) ? Math.max(i.size, 0) : 1, d2 = vi(l2.he()) * c2, f2 = d2 / 2;
    switch (t.Xs = d2, i.position) {
      case "inBar":
        return t.st = h2.Rt(o2, a2), void (void 0 !== t.Kt && (t.Kt.st = t.st + f2 + r2 + 0.6 * e2));
      case "aboveBar":
        return t.st = h2.Rt(_2, a2) - f2 - s.nh, void 0 !== t.Kt && (t.Kt.st = t.st - f2 - 0.6 * e2, s.nh += 1.2 * e2), void (s.nh += d2 + r2);
      case "belowBar":
        return t.st = h2.Rt(u2, a2) + f2 + s.sh, void 0 !== t.Kt && (t.Kt.st = t.st + f2 + r2 + 0.6 * e2, s.sh += 1.2 * e2), void (s.sh += d2 + r2);
    }
    i.position;
  }
  var yi = class {
    constructor(t, i) {
      this.ft = true, this.eh = true, this.rh = true, this.hh = null, this.ah = null, this.Wt = new Mi(), this.Wr = t, this.$i = i, this.zt = { it: [], tt: null };
    }
    bt(t) {
      this.ft = true, this.rh = true, "data" === t && (this.eh = true, this.ah = null);
    }
    gt(t) {
      if (!this.Wr.yt()) return null;
      this.ft && this.oh();
      const i = this.$i.W().layout;
      return this.Wt.ar(i.fontSize, i.fontFamily), this.Wt.J(this.zt), this.Wt;
    }
    _h() {
      if (this.rh) {
        if (this.Wr.uh().length > 0) {
          const t = this.$i.St().he(), i = pi(t), n = 1.5 * vi(t) + 2 * i, s = this.dh();
          this.hh = { above: mi(n, s.aboveBar, s.inBar), below: mi(n, s.belowBar, s.inBar) };
        } else this.hh = null;
        this.rh = false;
      }
      return this.hh;
    }
    dh() {
      return null === this.ah && (this.ah = this.Wr.uh().reduce(((t, i) => (t[i.position] || (t[i.position] = true), t)), { inBar: false, aboveBar: false, belowBar: false })), this.ah;
    }
    oh() {
      const t = this.Wr.Dt(), i = this.$i.St(), n = this.Wr.uh();
      this.eh && (this.zt.it = n.map(((t2) => ({ ot: t2.time, nt: 0, st: 0, Xs: 0, ih: t2.shape, V: t2.color, Qr: t2.Qr, wr: t2.id, Kt: void 0 }))), this.eh = false);
      const s = this.$i.W().layout;
      this.zt.tt = null;
      const e2 = i.Zs();
      if (null === e2) return;
      const r2 = this.Wr.Ct();
      if (null === r2) return;
      if (0 === this.zt.it.length) return;
      let h2 = NaN;
      const l2 = pi(i.he()), a2 = { nh: l2, sh: l2 };
      this.zt.tt = Lt(this.zt.it, e2, true);
      for (let e3 = this.zt.tt.from; e3 < this.zt.tt.to; e3++) {
        const o2 = n[e3];
        o2.time !== h2 && (a2.nh = l2, a2.sh = l2, h2 = o2.time);
        const _2 = this.zt.it[e3];
        _2.nt = i.It(o2.time), void 0 !== o2.text && o2.text.length > 0 && (_2.Kt = { th: o2.text, nt: 0, st: 0, Hi: 0, At: 0 });
        const u2 = this.Wr.fh(o2.time);
        null !== u2 && ki(_2, o2, u2, a2, s.fontSize, l2, t, i, r2.Vt);
      }
      this.ft = false;
    }
  };
  var Ci = class extends hi {
    constructor(t) {
      super(t);
    }
    kr() {
      const t = this.Mr;
      t.yt = false;
      const i = this.Ls.W();
      if (!i.priceLineVisible || !this.Ls.yt()) return;
      const n = this.Ls.Yr(0 === i.priceLineSource);
      n.Zr || (t.yt = true, t.st = n.ki, t.V = this.Ls.ph(n.V), t.et = i.priceLineWidth, t.Nt = i.priceLineStyle);
    }
  };
  var Ti = class extends nt {
    constructor(t) {
      super(), this.jt = t;
    }
    zi(t, i, n) {
      t.yt = false, i.yt = false;
      const s = this.jt;
      if (!s.yt()) return;
      const e2 = s.W(), r2 = e2.lastValueVisible, h2 = "" !== s.mh(), l2 = 0 === e2.seriesLastValueMode, a2 = s.Yr(false);
      if (a2.Zr) return;
      r2 && (t.Kt = this.bh(a2, r2, l2), t.yt = 0 !== t.Kt.length), (h2 || l2) && (i.Kt = this.wh(a2, r2, h2, l2), i.yt = i.Kt.length > 0);
      const o2 = s.ph(a2.V), _2 = R(o2);
      n.t = _2.t, n.ki = a2.ki, i.Ot = s.$t().Bt(a2.ki / s.Dt().At()), t.Ot = o2, t.V = _2.i, i.V = _2.i;
    }
    wh(t, i, n, s) {
      let e2 = "";
      const r2 = this.jt.mh();
      return n && 0 !== r2.length && (e2 += `${r2} `), i && s && (e2 += this.jt.Dt().gh() ? t.Mh : t.xh), e2.trim();
    }
    bh(t, i, n) {
      return i ? n ? this.jt.Dt().gh() ? t.xh : t.Mh : t.Kt : "";
    }
  };
  function Pi(t, i, n, s) {
    const e2 = Number.isFinite(i), r2 = Number.isFinite(n);
    return e2 && r2 ? t(i, n) : e2 || r2 ? e2 ? i : n : s;
  }
  var Ri = class _Ri {
    constructor(t, i) {
      this.Sh = t, this.kh = i;
    }
    yh(t) {
      return null !== t && (this.Sh === t.Sh && this.kh === t.kh);
    }
    Ch() {
      return new _Ri(this.Sh, this.kh);
    }
    Th() {
      return this.Sh;
    }
    Ph() {
      return this.kh;
    }
    Rh() {
      return this.kh - this.Sh;
    }
    Ni() {
      return this.kh === this.Sh || Number.isNaN(this.kh) || Number.isNaN(this.Sh);
    }
    ts(t) {
      return null === t ? this : new _Ri(Pi(Math.min, this.Th(), t.Th(), -1 / 0), Pi(Math.max, this.Ph(), t.Ph(), 1 / 0));
    }
    Dh(t) {
      if (!O(t)) return;
      if (0 === this.kh - this.Sh) return;
      const i = 0.5 * (this.kh + this.Sh);
      let n = this.kh - i, s = this.Sh - i;
      n *= t, s *= t, this.kh = i + n, this.Sh = i + s;
    }
    Vh(t) {
      O(t) && (this.kh += t, this.Sh += t);
    }
    Oh() {
      return { minValue: this.Sh, maxValue: this.kh };
    }
    static Bh(t) {
      return null === t ? null : new _Ri(t.minValue, t.maxValue);
    }
  };
  var Di = class _Di {
    constructor(t, i) {
      this.Ah = t, this.Ih = i || null;
    }
    zh() {
      return this.Ah;
    }
    Lh() {
      return this.Ih;
    }
    Oh() {
      return null === this.Ah ? null : { priceRange: this.Ah.Oh(), margins: this.Ih || void 0 };
    }
    static Bh(t) {
      return null === t ? null : new _Di(Ri.Bh(t.priceRange), t.margins);
    }
  };
  var Vi = class extends hi {
    constructor(t, i) {
      super(t), this.Eh = i;
    }
    kr() {
      const t = this.Mr;
      t.yt = false;
      const i = this.Eh.W();
      if (!this.Ls.yt() || !i.lineVisible) return;
      const n = this.Eh.Nh();
      null !== n && (t.yt = true, t.st = n, t.V = i.color, t.et = i.lineWidth, t.Nt = i.lineStyle, t.wr = this.Eh.W().id);
    }
  };
  var Oi = class extends nt {
    constructor(t, i) {
      super(), this.Wr = t, this.Eh = i;
    }
    zi(t, i, n) {
      t.yt = false, i.yt = false;
      const s = this.Eh.W(), e2 = s.axisLabelVisible, r2 = "" !== s.title, h2 = this.Wr;
      if (!e2 || !h2.yt()) return;
      const l2 = this.Eh.Nh();
      if (null === l2) return;
      r2 && (i.Kt = s.title, i.yt = true), i.Ot = h2.$t().Bt(l2 / h2.Dt().At()), t.Kt = this.Fh(s.price), t.yt = true;
      const a2 = R(s.axisLabelColor || s.color);
      n.t = a2.t;
      const o2 = s.axisLabelTextColor || a2.i;
      t.V = o2, i.V = o2, n.ki = l2;
    }
    Fh(t) {
      const i = this.Wr.Ct();
      return null === i ? "" : this.Wr.Dt().Fi(t, i.Vt);
    }
  };
  var Bi = class {
    constructor(t, i) {
      this.Wr = t, this.cn = i, this.Wh = new Vi(t, this), this._r = new Oi(t, this), this.jh = new ei(this._r, t, t.$t());
    }
    Hh(t) {
      V(this.cn, t), this.bt(), this.Wr.$t().$h();
    }
    W() {
      return this.cn;
    }
    Uh() {
      return this.Wh;
    }
    qh() {
      return this.jh;
    }
    Yh() {
      return this._r;
    }
    bt() {
      this.Wh.bt(), this._r.bt();
    }
    Nh() {
      const t = this.Wr, i = t.Dt();
      if (t.$t().St().Ni() || i.Ni()) return null;
      const n = t.Ct();
      return null === n ? null : i.Rt(this.cn.price, n.Vt);
    }
  };
  var Ai = class extends lt {
    constructor(t) {
      super(), this.$i = t;
    }
    $t() {
      return this.$i;
    }
  };
  var Ii = { Bar: (t, i, n, s) => {
    var e2;
    const r2 = i.upColor, h2 = i.downColor, l2 = b(t(n, s)), a2 = w(l2.Vt[0]) <= w(l2.Vt[3]);
    return { ue: null !== (e2 = l2.V) && void 0 !== e2 ? e2 : a2 ? r2 : h2 };
  }, Candlestick: (t, i, n, s) => {
    var e2, r2, h2;
    const l2 = i.upColor, a2 = i.downColor, o2 = i.borderUpColor, _2 = i.borderDownColor, u2 = i.wickUpColor, c2 = i.wickDownColor, d2 = b(t(n, s)), f2 = w(d2.Vt[0]) <= w(d2.Vt[3]);
    return { ue: null !== (e2 = d2.V) && void 0 !== e2 ? e2 : f2 ? l2 : a2, Ee: null !== (r2 = d2.Ot) && void 0 !== r2 ? r2 : f2 ? o2 : _2, Le: null !== (h2 = d2.Zh) && void 0 !== h2 ? h2 : f2 ? u2 : c2 };
  }, Custom: (t, i, n, s) => {
    var e2;
    return { ue: null !== (e2 = b(t(n, s)).V) && void 0 !== e2 ? e2 : i.color };
  }, Area: (t, i, n, s) => {
    var e2, r2, h2, l2;
    const a2 = b(t(n, s));
    return { ue: null !== (e2 = a2.lt) && void 0 !== e2 ? e2 : i.lineColor, lt: null !== (r2 = a2.lt) && void 0 !== r2 ? r2 : i.lineColor, Ts: null !== (h2 = a2.Ts) && void 0 !== h2 ? h2 : i.topColor, Ps: null !== (l2 = a2.Ps) && void 0 !== l2 ? l2 : i.bottomColor };
  }, Baseline: (t, i, n, s) => {
    var e2, r2, h2, l2, a2, o2;
    const _2 = b(t(n, s));
    return { ue: _2.Vt[3] >= i.baseValue.price ? i.topLineColor : i.bottomLineColor, Pe: null !== (e2 = _2.Pe) && void 0 !== e2 ? e2 : i.topLineColor, Re: null !== (r2 = _2.Re) && void 0 !== r2 ? r2 : i.bottomLineColor, Se: null !== (h2 = _2.Se) && void 0 !== h2 ? h2 : i.topFillColor1, ke: null !== (l2 = _2.ke) && void 0 !== l2 ? l2 : i.topFillColor2, ye: null !== (a2 = _2.ye) && void 0 !== a2 ? a2 : i.bottomFillColor1, Ce: null !== (o2 = _2.Ce) && void 0 !== o2 ? o2 : i.bottomFillColor2 };
  }, Line: (t, i, n, s) => {
    var e2, r2;
    const h2 = b(t(n, s));
    return { ue: null !== (e2 = h2.V) && void 0 !== e2 ? e2 : i.color, lt: null !== (r2 = h2.V) && void 0 !== r2 ? r2 : i.color };
  }, Histogram: (t, i, n, s) => {
    var e2;
    return { ue: null !== (e2 = b(t(n, s)).V) && void 0 !== e2 ? e2 : i.color };
  } };
  var zi = class {
    constructor(t) {
      this.Xh = (t2, i) => void 0 !== i ? i.Vt : this.Wr.In().Kh(t2), this.Wr = t, this.Gh = Ii[t.Jh()];
    }
    Hs(t, i) {
      return this.Gh(this.Xh, this.Wr.W(), t, i);
    }
  };
  var Li;
  !(function(t) {
    t[t.NearestLeft = -1] = "NearestLeft", t[t.None = 0] = "None", t[t.NearestRight = 1] = "NearestRight";
  })(Li || (Li = {}));
  var Ei = 30;
  var Ni = class {
    constructor() {
      this.Qh = [], this.tl = /* @__PURE__ */ new Map(), this.il = /* @__PURE__ */ new Map();
    }
    nl() {
      return this.Xs() > 0 ? this.Qh[this.Qh.length - 1] : null;
    }
    sl() {
      return this.Xs() > 0 ? this.el(0) : null;
    }
    An() {
      return this.Xs() > 0 ? this.el(this.Qh.length - 1) : null;
    }
    Xs() {
      return this.Qh.length;
    }
    Ni() {
      return 0 === this.Xs();
    }
    Xr(t) {
      return null !== this.rl(t, 0);
    }
    Kh(t) {
      return this.hl(t);
    }
    hl(t, i = 0) {
      const n = this.rl(t, i);
      return null === n ? null : Object.assign(Object.assign({}, this.ll(n)), { se: this.el(n) });
    }
    ie() {
      return this.Qh;
    }
    al(t, i, n) {
      if (this.Ni()) return null;
      let s = null;
      for (const e2 of n) {
        s = Fi(s, this.ol(t, i, e2));
      }
      return s;
    }
    J(t) {
      this.il.clear(), this.tl.clear(), this.Qh = t;
    }
    el(t) {
      return this.Qh[t].se;
    }
    ll(t) {
      return this.Qh[t];
    }
    rl(t, i) {
      const n = this._l(t);
      if (null === n && 0 !== i) switch (i) {
        case -1:
          return this.ul(t);
        case 1:
          return this.cl(t);
        default:
          throw new TypeError("Unknown search mode");
      }
      return n;
    }
    ul(t) {
      let i = this.dl(t);
      return i > 0 && (i -= 1), i !== this.Qh.length && this.el(i) < t ? i : null;
    }
    cl(t) {
      const i = this.fl(t);
      return i !== this.Qh.length && t < this.el(i) ? i : null;
    }
    _l(t) {
      const i = this.dl(t);
      return i === this.Qh.length || t < this.Qh[i].se ? null : i;
    }
    dl(t) {
      return Bt(this.Qh, t, ((t2, i) => t2.se < i));
    }
    fl(t) {
      return At(this.Qh, t, ((t2, i) => t2.se > i));
    }
    vl(t, i, n) {
      let s = null;
      for (let e2 = t; e2 < i; e2++) {
        const t2 = this.Qh[e2].Vt[n];
        Number.isNaN(t2) || (null === s ? s = { pl: t2, ml: t2 } : (t2 < s.pl && (s.pl = t2), t2 > s.ml && (s.ml = t2)));
      }
      return s;
    }
    ol(t, i, n) {
      if (this.Ni()) return null;
      let s = null;
      const e2 = b(this.sl()), r2 = b(this.An()), h2 = Math.max(t, e2), l2 = Math.min(i, r2), a2 = Math.ceil(h2 / Ei) * Ei, o2 = Math.max(a2, Math.floor(l2 / Ei) * Ei);
      {
        const t2 = this.dl(h2), e3 = this.fl(Math.min(l2, a2, i));
        s = Fi(s, this.vl(t2, e3, n));
      }
      let _2 = this.tl.get(n);
      void 0 === _2 && (_2 = /* @__PURE__ */ new Map(), this.tl.set(n, _2));
      for (let t2 = Math.max(a2 + 1, h2); t2 < o2; t2 += Ei) {
        const i2 = Math.floor(t2 / Ei);
        let e3 = _2.get(i2);
        if (void 0 === e3) {
          const t3 = this.dl(i2 * Ei), s2 = this.fl((i2 + 1) * Ei - 1);
          e3 = this.vl(t3, s2, n), _2.set(i2, e3);
        }
        s = Fi(s, e3);
      }
      {
        const t2 = this.dl(o2), i2 = this.fl(l2);
        s = Fi(s, this.vl(t2, i2, n));
      }
      return s;
    }
  };
  function Fi(t, i) {
    if (null === t) return i;
    if (null === i) return t;
    return { pl: Math.min(t.pl, i.pl), ml: Math.max(t.ml, i.ml) };
  }
  var Wi = class {
    constructor(t) {
      this.bl = t;
    }
    X(t, i, n) {
      this.bl.draw(t);
    }
    wl(t, i, n) {
      var s, e2;
      null === (e2 = (s = this.bl).drawBackground) || void 0 === e2 || e2.call(s, t);
    }
  };
  var ji = class {
    constructor(t) {
      this.Qe = null, this.wn = t;
    }
    gt() {
      var t;
      const i = this.wn.renderer();
      if (null === i) return null;
      if ((null === (t = this.Qe) || void 0 === t ? void 0 : t.gl) === i) return this.Qe.Ml;
      const n = new Wi(i);
      return this.Qe = { gl: i, Ml: n }, n;
    }
    xl() {
      var t, i, n;
      return null !== (n = null === (i = (t = this.wn).zOrder) || void 0 === i ? void 0 : i.call(t)) && void 0 !== n ? n : "normal";
    }
  };
  function Hi(t) {
    var i, n, s, e2, r2;
    return { Kt: t.text(), ki: t.coordinate(), Si: null === (i = t.fixedCoordinate) || void 0 === i ? void 0 : i.call(t), V: t.textColor(), t: t.backColor(), yt: null === (s = null === (n = t.visible) || void 0 === n ? void 0 : n.call(t)) || void 0 === s || s, hi: null === (r2 = null === (e2 = t.tickVisible) || void 0 === e2 ? void 0 : e2.call(t)) || void 0 === r2 || r2 };
  }
  var $i = class {
    constructor(t, i) {
      this.Wt = new rt(), this.Sl = t, this.kl = i;
    }
    gt() {
      return this.Wt.J(Object.assign({ Hi: this.kl.Hi() }, Hi(this.Sl))), this.Wt;
    }
  };
  var Ui = class extends nt {
    constructor(t, i) {
      super(), this.Sl = t, this.Li = i;
    }
    zi(t, i, n) {
      const s = Hi(this.Sl);
      n.t = s.t, t.V = s.V;
      const e2 = 2 / 12 * this.Li.P();
      n.wi = e2, n.gi = e2, n.ki = s.ki, n.Si = s.Si, t.Kt = s.Kt, t.yt = s.yt, t.hi = s.hi;
    }
  };
  var qi = class {
    constructor(t, i) {
      this.yl = null, this.Cl = null, this.Tl = null, this.Pl = null, this.Rl = null, this.Dl = t, this.Wr = i;
    }
    Vl() {
      return this.Dl;
    }
    Vn() {
      var t, i;
      null === (i = (t = this.Dl).updateAllViews) || void 0 === i || i.call(t);
    }
    Pn() {
      var t, i, n, s;
      const e2 = null !== (n = null === (i = (t = this.Dl).paneViews) || void 0 === i ? void 0 : i.call(t)) && void 0 !== n ? n : [];
      if ((null === (s = this.yl) || void 0 === s ? void 0 : s.gl) === e2) return this.yl.Ml;
      const r2 = e2.map(((t2) => new ji(t2)));
      return this.yl = { gl: e2, Ml: r2 }, r2;
    }
    Qi() {
      var t, i, n, s;
      const e2 = null !== (n = null === (i = (t = this.Dl).timeAxisViews) || void 0 === i ? void 0 : i.call(t)) && void 0 !== n ? n : [];
      if ((null === (s = this.Cl) || void 0 === s ? void 0 : s.gl) === e2) return this.Cl.Ml;
      const r2 = this.Wr.$t().St(), h2 = e2.map(((t2) => new $i(t2, r2)));
      return this.Cl = { gl: e2, Ml: h2 }, h2;
    }
    Rn() {
      var t, i, n, s;
      const e2 = null !== (n = null === (i = (t = this.Dl).priceAxisViews) || void 0 === i ? void 0 : i.call(t)) && void 0 !== n ? n : [];
      if ((null === (s = this.Tl) || void 0 === s ? void 0 : s.gl) === e2) return this.Tl.Ml;
      const r2 = this.Wr.Dt(), h2 = e2.map(((t2) => new Ui(t2, r2)));
      return this.Tl = { gl: e2, Ml: h2 }, h2;
    }
    Ol() {
      var t, i, n, s;
      const e2 = null !== (n = null === (i = (t = this.Dl).priceAxisPaneViews) || void 0 === i ? void 0 : i.call(t)) && void 0 !== n ? n : [];
      if ((null === (s = this.Pl) || void 0 === s ? void 0 : s.gl) === e2) return this.Pl.Ml;
      const r2 = e2.map(((t2) => new ji(t2)));
      return this.Pl = { gl: e2, Ml: r2 }, r2;
    }
    Bl() {
      var t, i, n, s;
      const e2 = null !== (n = null === (i = (t = this.Dl).timeAxisPaneViews) || void 0 === i ? void 0 : i.call(t)) && void 0 !== n ? n : [];
      if ((null === (s = this.Rl) || void 0 === s ? void 0 : s.gl) === e2) return this.Rl.Ml;
      const r2 = e2.map(((t2) => new ji(t2)));
      return this.Rl = { gl: e2, Ml: r2 }, r2;
    }
    Al(t, i) {
      var n, s, e2;
      return null !== (e2 = null === (s = (n = this.Dl).autoscaleInfo) || void 0 === s ? void 0 : s.call(n, t, i)) && void 0 !== e2 ? e2 : null;
    }
    br(t, i) {
      var n, s, e2;
      return null !== (e2 = null === (s = (n = this.Dl).hitTest) || void 0 === s ? void 0 : s.call(n, t, i)) && void 0 !== e2 ? e2 : null;
    }
  };
  function Yi(t, i, n, s) {
    t.forEach(((t2) => {
      i(t2).forEach(((t3) => {
        t3.xl() === n && s.push(t3);
      }));
    }));
  }
  function Zi(t) {
    return t.Pn();
  }
  function Xi(t) {
    return t.Ol();
  }
  function Ki(t) {
    return t.Bl();
  }
  var Gi = class extends Ai {
    constructor(t, i, n, s, e2) {
      super(t), this.zt = new Ni(), this.Wh = new Ci(this), this.Il = [], this.zl = new li(this), this.Ll = null, this.El = null, this.Nl = [], this.Fl = [], this.Wl = null, this.jl = [], this.cn = i, this.Hl = n;
      const r2 = new Ti(this);
      this.rn = [r2], this.jh = new ei(r2, this, t), "Area" !== n && "Line" !== n && "Baseline" !== n || (this.Ll = new ci(this)), this.$l(), this.Ul(e2);
    }
    S() {
      null !== this.Wl && clearTimeout(this.Wl);
    }
    ph(t) {
      return this.cn.priceLineColor || t;
    }
    Yr(t) {
      const i = { Zr: true }, n = this.Dt();
      if (this.$t().St().Ni() || n.Ni() || this.zt.Ni()) return i;
      const s = this.$t().St().Zs(), e2 = this.Ct();
      if (null === s || null === e2) return i;
      let r2, h2;
      if (t) {
        const t2 = this.zt.nl();
        if (null === t2) return i;
        r2 = t2, h2 = t2.se;
      } else {
        const t2 = this.zt.hl(s.ui(), -1);
        if (null === t2) return i;
        if (r2 = this.zt.Kh(t2.se), null === r2) return i;
        h2 = t2.se;
      }
      const l2 = r2.Vt[3], a2 = this.$s().Hs(h2, { Vt: r2 }), o2 = n.Rt(l2, e2.Vt);
      return { Zr: false, _t: l2, Kt: n.Fi(l2, e2.Vt), Mh: n.ql(l2), xh: n.Yl(l2, e2.Vt), V: a2.ue, ki: o2, se: h2 };
    }
    $s() {
      return null !== this.El || (this.El = new zi(this)), this.El;
    }
    W() {
      return this.cn;
    }
    Hh(t) {
      const i = t.priceScaleId;
      void 0 !== i && i !== this.cn.priceScaleId && this.$t().Zl(this, i), V(this.cn, t), void 0 !== t.priceFormat && (this.$l(), this.$t().Xl()), this.$t().Kl(this), this.$t().Gl(), this.wn.bt("options");
    }
    J(t, i) {
      this.zt.J(t), this.Jl(), this.wn.bt("data"), this.dn.bt("data"), null !== this.Ll && (i && i.Ql ? this.Ll.Hr() : 0 === t.length && this.Ll.jr());
      const n = this.$t().cr(this);
      this.$t().ta(n), this.$t().Kl(this), this.$t().Gl(), this.$t().$h();
    }
    ia(t) {
      this.Nl = t, this.Jl();
      const i = this.$t().cr(this);
      this.dn.bt("data"), this.$t().ta(i), this.$t().Kl(this), this.$t().Gl(), this.$t().$h();
    }
    na() {
      return this.Nl;
    }
    uh() {
      return this.Fl;
    }
    sa(t) {
      const i = new Bi(this, t);
      return this.Il.push(i), this.$t().Kl(this), i;
    }
    ea(t) {
      const i = this.Il.indexOf(t);
      -1 !== i && this.Il.splice(i, 1), this.$t().Kl(this);
    }
    Jh() {
      return this.Hl;
    }
    Ct() {
      const t = this.ra();
      return null === t ? null : { Vt: t.Vt[3], ha: t.ot };
    }
    ra() {
      const t = this.$t().St().Zs();
      if (null === t) return null;
      const i = t.Vs();
      return this.zt.hl(i, 1);
    }
    In() {
      return this.zt;
    }
    fh(t) {
      const i = this.zt.Kh(t);
      return null === i ? null : "Bar" === this.Hl || "Candlestick" === this.Hl || "Custom" === this.Hl ? { we: i.Vt[0], ge: i.Vt[1], Me: i.Vt[2], xe: i.Vt[3] } : i.Vt[3];
    }
    la(t) {
      const i = [];
      Yi(this.jl, Zi, "top", i);
      const n = this.Ll;
      return null !== n && n.yt() ? (null === this.Wl && n.Ur() && (this.Wl = setTimeout((() => {
        this.Wl = null, this.$t().aa();
      }), 0)), n.$r(), i.unshift(n), i) : i;
    }
    Pn() {
      const t = [];
      this.oa() || t.push(this.zl), t.push(this.wn, this.Wh, this.dn);
      const i = this.Il.map(((t2) => t2.Uh()));
      return t.push(...i), Yi(this.jl, Zi, "normal", t), t;
    }
    _a() {
      return this.ua(Zi, "bottom");
    }
    ca(t) {
      return this.ua(Xi, t);
    }
    da(t) {
      return this.ua(Ki, t);
    }
    fa(t, i) {
      return this.jl.map(((n) => n.br(t, i))).filter(((t2) => null !== t2));
    }
    Ji(t) {
      return [this.jh, ...this.Il.map(((t2) => t2.qh()))];
    }
    Rn(t, i) {
      if (i !== this.Yi && !this.oa()) return [];
      const n = [...this.rn];
      for (const t2 of this.Il) n.push(t2.Yh());
      return this.jl.forEach(((t2) => {
        n.push(...t2.Rn());
      })), n;
    }
    Qi() {
      const t = [];
      return this.jl.forEach(((i) => {
        t.push(...i.Qi());
      })), t;
    }
    Al(t, i) {
      if (void 0 !== this.cn.autoscaleInfoProvider) {
        const n = this.cn.autoscaleInfoProvider((() => {
          const n2 = this.va(t, i);
          return null === n2 ? null : n2.Oh();
        }));
        return Di.Bh(n);
      }
      return this.va(t, i);
    }
    pa() {
      return this.cn.priceFormat.minMove;
    }
    ma() {
      return this.ba;
    }
    Vn() {
      var t;
      this.wn.bt(), this.dn.bt();
      for (const t2 of this.rn) t2.bt();
      for (const t2 of this.Il) t2.bt();
      this.Wh.bt(), this.zl.bt(), null === (t = this.Ll) || void 0 === t || t.bt(), this.jl.forEach(((t2) => t2.Vn()));
    }
    Dt() {
      return b(super.Dt());
    }
    kt(t) {
      if (!(("Line" === this.Hl || "Area" === this.Hl || "Baseline" === this.Hl) && this.cn.crosshairMarkerVisible)) return null;
      const i = this.zt.Kh(t);
      if (null === i) return null;
      return { _t: i.Vt[3], ht: this.wa(), Ot: this.ga(), Pt: this.Ma(), Tt: this.xa(t) };
    }
    mh() {
      return this.cn.title;
    }
    yt() {
      return this.cn.visible;
    }
    Sa(t) {
      this.jl.push(new qi(t, this));
    }
    ka(t) {
      this.jl = this.jl.filter(((i) => i.Vl() !== t));
    }
    ya() {
      if (this.wn instanceof Kt != false) return (t) => this.wn.Fe(t);
    }
    Ca() {
      if (this.wn instanceof Kt != false) return (t) => this.wn.We(t);
    }
    oa() {
      return !_t(this.Dt().Ta());
    }
    va(t, i) {
      if (!B(t) || !B(i) || this.zt.Ni()) return null;
      const n = "Line" === this.Hl || "Area" === this.Hl || "Baseline" === this.Hl || "Histogram" === this.Hl ? [3] : [2, 1], s = this.zt.al(t, i, n);
      let e2 = null !== s ? new Ri(s.pl, s.ml) : null;
      if ("Histogram" === this.Jh()) {
        const t2 = this.cn.base, i2 = new Ri(t2, t2);
        e2 = null !== e2 ? e2.ts(i2) : i2;
      }
      let r2 = this.dn._h();
      return this.jl.forEach(((n2) => {
        const s2 = n2.Al(t, i);
        if (null == s2 ? void 0 : s2.priceRange) {
          const t2 = new Ri(s2.priceRange.minValue, s2.priceRange.maxValue);
          e2 = null !== e2 ? e2.ts(t2) : t2;
        }
        var h2, l2, a2, o2;
        (null == s2 ? void 0 : s2.margins) && (h2 = r2, l2 = s2.margins, r2 = { above: Math.max(null !== (a2 = null == h2 ? void 0 : h2.above) && void 0 !== a2 ? a2 : 0, l2.above), below: Math.max(null !== (o2 = null == h2 ? void 0 : h2.below) && void 0 !== o2 ? o2 : 0, l2.below) });
      })), new Di(e2, r2);
    }
    wa() {
      switch (this.Hl) {
        case "Line":
        case "Area":
        case "Baseline":
          return this.cn.crosshairMarkerRadius;
      }
      return 0;
    }
    ga() {
      switch (this.Hl) {
        case "Line":
        case "Area":
        case "Baseline": {
          const t = this.cn.crosshairMarkerBorderColor;
          if (0 !== t.length) return t;
        }
      }
      return null;
    }
    Ma() {
      switch (this.Hl) {
        case "Line":
        case "Area":
        case "Baseline":
          return this.cn.crosshairMarkerBorderWidth;
      }
      return 0;
    }
    xa(t) {
      switch (this.Hl) {
        case "Line":
        case "Area":
        case "Baseline": {
          const t2 = this.cn.crosshairMarkerBackgroundColor;
          if (0 !== t2.length) return t2;
        }
      }
      return this.$s().Hs(t).ue;
    }
    $l() {
      switch (this.cn.priceFormat.type) {
        case "custom":
          this.ba = { format: this.cn.priceFormat.formatter };
          break;
        case "volume":
          this.ba = new pt(this.cn.priceFormat.precision);
          break;
        case "percent":
          this.ba = new vt(this.cn.priceFormat.precision);
          break;
        default: {
          const t = Math.pow(10, this.cn.priceFormat.precision);
          this.ba = new ft(t, this.cn.priceFormat.minMove * t);
        }
      }
      null !== this.Yi && this.Yi.Pa();
    }
    Jl() {
      const t = this.$t().St();
      if (!t.Ra() || this.zt.Ni()) return void (this.Fl = []);
      const i = b(this.zt.sl());
      this.Fl = this.Nl.map(((n, s) => {
        const e2 = b(t.Da(n.time, true)), r2 = e2 < i ? 1 : -1;
        return { time: b(this.zt.hl(e2, r2)).se, position: n.position, shape: n.shape, color: n.color, id: n.id, Qr: s, text: n.text, size: n.size, originalTime: n.originalTime };
      }));
    }
    Ul(t) {
      switch (this.dn = new yi(this, this.$t()), this.Hl) {
        case "Bar":
          this.wn = new Ht(this, this.$t());
          break;
        case "Candlestick":
          this.wn = new Zt(this, this.$t());
          break;
        case "Line":
          this.wn = new ti(this, this.$t());
          break;
        case "Custom":
          this.wn = new Kt(this, this.$t(), m(t));
          break;
        case "Area":
          this.wn = new Ft(this, this.$t());
          break;
        case "Baseline":
          this.wn = new qt(this, this.$t());
          break;
        case "Histogram":
          this.wn = new Qt(this, this.$t());
          break;
        default:
          throw Error("Unknown chart style assigned: " + this.Hl);
      }
    }
    ua(t, i) {
      const n = [];
      return Yi(this.jl, t, i, n), n;
    }
  };
  var Ji = class {
    constructor(t) {
      this.cn = t;
    }
    Va(t, i, n) {
      let s = t;
      if (0 === this.cn.mode) return s;
      const e2 = n.vn(), r2 = e2.Ct();
      if (null === r2) return s;
      const h2 = e2.Rt(t, r2), l2 = n.Oa().filter(((t2) => t2 instanceof Gi)).reduce(((t2, s2) => {
        if (n.dr(s2) || !s2.yt()) return t2;
        const e3 = s2.Dt(), r3 = s2.In();
        if (e3.Ni() || !r3.Xr(i)) return t2;
        const h3 = r3.Kh(i);
        if (null === h3) return t2;
        const l3 = w(s2.Ct());
        return t2.concat([e3.Rt(h3.Vt[3], l3.Vt)]);
      }), []);
      if (0 === l2.length) return s;
      l2.sort(((t2, i2) => Math.abs(t2 - h2) - Math.abs(i2 - h2)));
      const a2 = l2[0];
      return s = e2.pn(a2, r2), s;
    }
  };
  var Qi = class extends H {
    constructor() {
      super(...arguments), this.zt = null;
    }
    J(t) {
      this.zt = t;
    }
    K({ context: t, bitmapSize: i, horizontalPixelRatio: n, verticalPixelRatio: s }) {
      if (null === this.zt) return;
      const e2 = Math.max(1, Math.floor(n));
      t.lineWidth = e2, (function(t2, i2) {
        t2.save(), t2.lineWidth % 2 && t2.translate(0.5, 0.5), i2(), t2.restore();
      })(t, (() => {
        const r2 = b(this.zt);
        if (r2.Ba) {
          t.strokeStyle = r2.Aa, f(t, r2.Ia), t.beginPath();
          for (const s2 of r2.za) {
            const r3 = Math.round(s2.La * n);
            t.moveTo(r3, -e2), t.lineTo(r3, i.height + e2);
          }
          t.stroke();
        }
        if (r2.Ea) {
          t.strokeStyle = r2.Na, f(t, r2.Fa), t.beginPath();
          for (const n2 of r2.Wa) {
            const r3 = Math.round(n2.La * s);
            t.moveTo(-e2, r3), t.lineTo(i.width + e2, r3);
          }
          t.stroke();
        }
      }));
    }
  };
  var tn = class {
    constructor(t) {
      this.Wt = new Qi(), this.ft = true, this.tn = t;
    }
    bt() {
      this.ft = true;
    }
    gt() {
      if (this.ft) {
        const t = this.tn.$t().W().grid, i = { Ea: t.horzLines.visible, Ba: t.vertLines.visible, Na: t.horzLines.color, Aa: t.vertLines.color, Fa: t.horzLines.style, Ia: t.vertLines.style, Wa: this.tn.vn().ja(), za: (this.tn.$t().St().ja() || []).map(((t2) => ({ La: t2.coord }))) };
        this.Wt.J(i), this.ft = false;
      }
      return this.Wt;
    }
  };
  var nn = class {
    constructor(t) {
      this.wn = new tn(t);
    }
    Uh() {
      return this.wn;
    }
  };
  var sn = { Ha: 4, $a: 1e-4 };
  function en(t, i) {
    const n = 100 * (t - i) / i;
    return i < 0 ? -n : n;
  }
  function rn(t, i) {
    const n = en(t.Th(), i), s = en(t.Ph(), i);
    return new Ri(n, s);
  }
  function hn(t, i) {
    const n = 100 * (t - i) / i + 100;
    return i < 0 ? -n : n;
  }
  function ln(t, i) {
    const n = hn(t.Th(), i), s = hn(t.Ph(), i);
    return new Ri(n, s);
  }
  function an(t, i) {
    const n = Math.abs(t);
    if (n < 1e-15) return 0;
    const s = Math.log10(n + i.$a) + i.Ha;
    return t < 0 ? -s : s;
  }
  function on(t, i) {
    const n = Math.abs(t);
    if (n < 1e-15) return 0;
    const s = Math.pow(10, n - i.Ha) - i.$a;
    return t < 0 ? -s : s;
  }
  function _n(t, i) {
    if (null === t) return null;
    const n = an(t.Th(), i), s = an(t.Ph(), i);
    return new Ri(n, s);
  }
  function un(t, i) {
    if (null === t) return null;
    const n = on(t.Th(), i), s = on(t.Ph(), i);
    return new Ri(n, s);
  }
  function cn(t) {
    if (null === t) return sn;
    const i = Math.abs(t.Ph() - t.Th());
    if (i >= 1 || i < 1e-15) return sn;
    const n = Math.ceil(Math.abs(Math.log10(i))), s = sn.Ha + n;
    return { Ha: s, $a: 1 / Math.pow(10, s) };
  }
  var dn = class {
    constructor(t, i) {
      if (this.Ua = t, this.qa = i, (function(t2) {
        if (t2 < 0) return false;
        for (let i2 = t2; i2 > 1; i2 /= 10) if (i2 % 10 != 0) return false;
        return true;
      })(this.Ua)) this.Ya = [2, 2.5, 2];
      else {
        this.Ya = [];
        for (let t2 = this.Ua; 1 !== t2; ) {
          if (t2 % 2 == 0) this.Ya.push(2), t2 /= 2;
          else {
            if (t2 % 5 != 0) throw new Error("unexpected base");
            this.Ya.push(2, 2.5), t2 /= 5;
          }
          if (this.Ya.length > 100) throw new Error("something wrong with base");
        }
      }
    }
    Za(t, i, n) {
      const s = 0 === this.Ua ? 0 : 1 / this.Ua;
      let e2 = Math.pow(10, Math.max(0, Math.ceil(Math.log10(t - i)))), r2 = 0, h2 = this.qa[0];
      for (; ; ) {
        const t2 = yt(e2, s, 1e-14) && e2 > s + 1e-14, i2 = yt(e2, n * h2, 1e-14), l3 = yt(e2, 1, 1e-14);
        if (!(t2 && i2 && l3)) break;
        e2 /= h2, h2 = this.qa[++r2 % this.qa.length];
      }
      if (e2 <= s + 1e-14 && (e2 = s), e2 = Math.max(1, e2), this.Ya.length > 0 && (l2 = e2, a2 = 1, o2 = 1e-14, Math.abs(l2 - a2) < o2)) for (r2 = 0, h2 = this.Ya[0]; yt(e2, n * h2, 1e-14) && e2 > s + 1e-14; ) e2 /= h2, h2 = this.Ya[++r2 % this.Ya.length];
      var l2, a2, o2;
      return e2;
    }
  };
  var fn = class {
    constructor(t, i, n, s) {
      this.Xa = [], this.Li = t, this.Ua = i, this.Ka = n, this.Ga = s;
    }
    Za(t, i) {
      if (t < i) throw new Error("high < low");
      const n = this.Li.At(), s = (t - i) * this.Ja() / n, e2 = new dn(this.Ua, [2, 2.5, 2]), r2 = new dn(this.Ua, [2, 2, 2.5]), h2 = new dn(this.Ua, [2.5, 2, 2]), l2 = [];
      return l2.push(e2.Za(t, i, s), r2.Za(t, i, s), h2.Za(t, i, s)), (function(t2) {
        if (t2.length < 1) throw Error("array is empty");
        let i2 = t2[0];
        for (let n2 = 1; n2 < t2.length; ++n2) t2[n2] < i2 && (i2 = t2[n2]);
        return i2;
      })(l2);
    }
    Qa() {
      const t = this.Li, i = t.Ct();
      if (null === i) return void (this.Xa = []);
      const n = t.At(), s = this.Ka(n - 1, i), e2 = this.Ka(0, i), r2 = this.Li.W().entireTextOnly ? this.io() / 2 : 0, h2 = r2, l2 = n - 1 - r2, a2 = Math.max(s, e2), o2 = Math.min(s, e2);
      if (a2 === o2) return void (this.Xa = []);
      let _2 = this.Za(a2, o2), u2 = a2 % _2;
      u2 += u2 < 0 ? _2 : 0;
      const c2 = a2 >= o2 ? 1 : -1;
      let d2 = null, f2 = 0;
      for (let n2 = a2 - u2; n2 > o2; n2 -= _2) {
        const s2 = this.Ga(n2, i, true);
        null !== d2 && Math.abs(s2 - d2) < this.Ja() || (s2 < h2 || s2 > l2 || (f2 < this.Xa.length ? (this.Xa[f2].La = s2, this.Xa[f2].no = t.so(n2)) : this.Xa.push({ La: s2, no: t.so(n2) }), f2++, d2 = s2, t.eo() && (_2 = this.Za(n2 * c2, o2))));
      }
      this.Xa.length = f2;
    }
    ja() {
      return this.Xa;
    }
    io() {
      return this.Li.P();
    }
    Ja() {
      return Math.ceil(2.5 * this.io());
    }
  };
  function vn(t) {
    return t.slice().sort(((t2, i) => b(t2.Xi()) - b(i.Xi())));
  }
  var pn;
  !(function(t) {
    t[t.Normal = 0] = "Normal", t[t.Logarithmic = 1] = "Logarithmic", t[t.Percentage = 2] = "Percentage", t[t.IndexedTo100 = 3] = "IndexedTo100";
  })(pn || (pn = {}));
  var mn = new vt();
  var bn = new ft(100, 1);
  var wn = class {
    constructor(t, i, n, s) {
      this.ro = 0, this.ho = null, this.Ah = null, this.lo = null, this.ao = { oo: false, _o: null }, this.uo = 0, this.co = 0, this.do = new D(), this.fo = new D(), this.vo = [], this.po = null, this.mo = null, this.bo = null, this.wo = null, this.ba = bn, this.Mo = cn(null), this.xo = t, this.cn = i, this.So = n, this.ko = s, this.yo = new fn(this, 100, this.Co.bind(this), this.To.bind(this));
    }
    Ta() {
      return this.xo;
    }
    W() {
      return this.cn;
    }
    Hh(t) {
      if (V(this.cn, t), this.Pa(), void 0 !== t.mode && this.Po({ yr: t.mode }), void 0 !== t.scaleMargins) {
        const i = m(t.scaleMargins.top), n = m(t.scaleMargins.bottom);
        if (i < 0 || i > 1) throw new Error(`Invalid top margin - expect value between 0 and 1, given=${i}`);
        if (n < 0 || n > 1) throw new Error(`Invalid bottom margin - expect value between 0 and 1, given=${n}`);
        if (i + n > 1) throw new Error(`Invalid margins - sum of margins must be less than 1, given=${i + n}`);
        this.Ro(), this.mo = null;
      }
    }
    Do() {
      return this.cn.autoScale;
    }
    eo() {
      return 1 === this.cn.mode;
    }
    gh() {
      return 2 === this.cn.mode;
    }
    Vo() {
      return 3 === this.cn.mode;
    }
    yr() {
      return { Wn: this.cn.autoScale, Oo: this.cn.invertScale, yr: this.cn.mode };
    }
    Po(t) {
      const i = this.yr();
      let n = null;
      void 0 !== t.Wn && (this.cn.autoScale = t.Wn), void 0 !== t.yr && (this.cn.mode = t.yr, 2 !== t.yr && 3 !== t.yr || (this.cn.autoScale = true), this.ao.oo = false), 1 === i.yr && t.yr !== i.yr && (!(function(t2, i2) {
        if (null === t2) return false;
        const n2 = on(t2.Th(), i2), s2 = on(t2.Ph(), i2);
        return isFinite(n2) && isFinite(s2);
      })(this.Ah, this.Mo) ? this.cn.autoScale = true : (n = un(this.Ah, this.Mo), null !== n && this.Bo(n))), 1 === t.yr && t.yr !== i.yr && (n = _n(this.Ah, this.Mo), null !== n && this.Bo(n));
      const s = i.yr !== this.cn.mode;
      s && (2 === i.yr || this.gh()) && this.Pa(), s && (3 === i.yr || this.Vo()) && this.Pa(), void 0 !== t.Oo && i.Oo !== t.Oo && (this.cn.invertScale = t.Oo, this.Ao()), this.fo.m(i, this.yr());
    }
    Io() {
      return this.fo;
    }
    P() {
      return this.So.fontSize;
    }
    At() {
      return this.ro;
    }
    zo(t) {
      this.ro !== t && (this.ro = t, this.Ro(), this.mo = null);
    }
    Lo() {
      if (this.ho) return this.ho;
      const t = this.At() - this.Eo() - this.No();
      return this.ho = t, t;
    }
    zh() {
      return this.Fo(), this.Ah;
    }
    Bo(t, i) {
      const n = this.Ah;
      (i || null === n && null !== t || null !== n && !n.yh(t)) && (this.mo = null, this.Ah = t);
    }
    Ni() {
      return this.Fo(), 0 === this.ro || !this.Ah || this.Ah.Ni();
    }
    Wo(t) {
      return this.Oo() ? t : this.At() - 1 - t;
    }
    Rt(t, i) {
      return this.gh() ? t = en(t, i) : this.Vo() && (t = hn(t, i)), this.To(t, i);
    }
    Qs(t, i, n) {
      this.Fo();
      const s = this.No(), e2 = b(this.zh()), r2 = e2.Th(), h2 = e2.Ph(), l2 = this.Lo() - 1, a2 = this.Oo(), o2 = l2 / (h2 - r2), _2 = void 0 === n ? 0 : n.from, u2 = void 0 === n ? t.length : n.to, c2 = this.jo();
      for (let n2 = _2; n2 < u2; n2++) {
        const e3 = t[n2], h3 = e3._t;
        if (isNaN(h3)) continue;
        let l3 = h3;
        null !== c2 && (l3 = c2(e3._t, i));
        const _3 = s + o2 * (l3 - r2), u3 = a2 ? _3 : this.ro - 1 - _3;
        e3.st = u3;
      }
    }
    me(t, i, n) {
      this.Fo();
      const s = this.No(), e2 = b(this.zh()), r2 = e2.Th(), h2 = e2.Ph(), l2 = this.Lo() - 1, a2 = this.Oo(), o2 = l2 / (h2 - r2), _2 = void 0 === n ? 0 : n.from, u2 = void 0 === n ? t.length : n.to, c2 = this.jo();
      for (let n2 = _2; n2 < u2; n2++) {
        const e3 = t[n2];
        let h3 = e3.we, l3 = e3.ge, _3 = e3.Me, u3 = e3.xe;
        null !== c2 && (h3 = c2(e3.we, i), l3 = c2(e3.ge, i), _3 = c2(e3.Me, i), u3 = c2(e3.xe, i));
        let d2 = s + o2 * (h3 - r2), f2 = a2 ? d2 : this.ro - 1 - d2;
        e3.ve = f2, d2 = s + o2 * (l3 - r2), f2 = a2 ? d2 : this.ro - 1 - d2, e3.ce = f2, d2 = s + o2 * (_3 - r2), f2 = a2 ? d2 : this.ro - 1 - d2, e3.de = f2, d2 = s + o2 * (u3 - r2), f2 = a2 ? d2 : this.ro - 1 - d2, e3.pe = f2;
      }
    }
    pn(t, i) {
      const n = this.Co(t, i);
      return this.Ho(n, i);
    }
    Ho(t, i) {
      let n = t;
      return this.gh() ? n = (function(t2, i2) {
        return i2 < 0 && (t2 = -t2), t2 / 100 * i2 + i2;
      })(n, i) : this.Vo() && (n = (function(t2, i2) {
        return t2 -= 100, i2 < 0 && (t2 = -t2), t2 / 100 * i2 + i2;
      })(n, i)), n;
    }
    Oa() {
      return this.vo;
    }
    $o() {
      if (this.po) return this.po;
      let t = [];
      for (let i = 0; i < this.vo.length; i++) {
        const n = this.vo[i];
        null === n.Xi() && n.Ki(i + 1), t.push(n);
      }
      return t = vn(t), this.po = t, this.po;
    }
    Uo(t) {
      -1 === this.vo.indexOf(t) && (this.vo.push(t), this.Pa(), this.qo());
    }
    Yo(t) {
      const i = this.vo.indexOf(t);
      if (-1 === i) throw new Error("source is not attached to scale");
      this.vo.splice(i, 1), 0 === this.vo.length && (this.Po({ Wn: true }), this.Bo(null)), this.Pa(), this.qo();
    }
    Ct() {
      let t = null;
      for (const i of this.vo) {
        const n = i.Ct();
        null !== n && ((null === t || n.ha < t.ha) && (t = n));
      }
      return null === t ? null : t.Vt;
    }
    Oo() {
      return this.cn.invertScale;
    }
    ja() {
      const t = null === this.Ct();
      if (null !== this.mo && (t || this.mo.Zo === t)) return this.mo.ja;
      this.yo.Qa();
      const i = this.yo.ja();
      return this.mo = { ja: i, Zo: t }, this.do.m(), i;
    }
    Xo() {
      return this.do;
    }
    Ko(t) {
      this.gh() || this.Vo() || null === this.bo && null === this.lo && (this.Ni() || (this.bo = this.ro - t, this.lo = b(this.zh()).Ch()));
    }
    Go(t) {
      if (this.gh() || this.Vo()) return;
      if (null === this.bo) return;
      this.Po({ Wn: false }), (t = this.ro - t) < 0 && (t = 0);
      let i = (this.bo + 0.2 * (this.ro - 1)) / (t + 0.2 * (this.ro - 1));
      const n = b(this.lo).Ch();
      i = Math.max(i, 0.1), n.Dh(i), this.Bo(n);
    }
    Jo() {
      this.gh() || this.Vo() || (this.bo = null, this.lo = null);
    }
    Qo(t) {
      this.Do() || null === this.wo && null === this.lo && (this.Ni() || (this.wo = t, this.lo = b(this.zh()).Ch()));
    }
    t_(t) {
      if (this.Do()) return;
      if (null === this.wo) return;
      const i = b(this.zh()).Rh() / (this.Lo() - 1);
      let n = t - this.wo;
      this.Oo() && (n *= -1);
      const s = n * i, e2 = b(this.lo).Ch();
      e2.Vh(s), this.Bo(e2, true), this.mo = null;
    }
    i_() {
      this.Do() || null !== this.wo && (this.wo = null, this.lo = null);
    }
    ma() {
      return this.ba || this.Pa(), this.ba;
    }
    Fi(t, i) {
      switch (this.cn.mode) {
        case 2:
          return this.n_(en(t, i));
        case 3:
          return this.ma().format(hn(t, i));
        default:
          return this.Fh(t);
      }
    }
    so(t) {
      switch (this.cn.mode) {
        case 2:
          return this.n_(t);
        case 3:
          return this.ma().format(t);
        default:
          return this.Fh(t);
      }
    }
    ql(t) {
      return this.Fh(t, b(this.s_()).ma());
    }
    Yl(t, i) {
      return t = en(t, i), this.n_(t, mn);
    }
    e_() {
      return this.vo;
    }
    r_(t) {
      this.ao = { _o: t, oo: false };
    }
    Vn() {
      this.vo.forEach(((t) => t.Vn()));
    }
    Pa() {
      this.mo = null;
      const t = this.s_();
      let i = 100;
      null !== t && (i = Math.round(1 / t.pa())), this.ba = bn, this.gh() ? (this.ba = mn, i = 100) : this.Vo() ? (this.ba = new ft(100, 1), i = 100) : null !== t && (this.ba = t.ma()), this.yo = new fn(this, i, this.Co.bind(this), this.To.bind(this)), this.yo.Qa();
    }
    qo() {
      this.po = null;
    }
    s_() {
      return this.vo[0] || null;
    }
    Eo() {
      return this.Oo() ? this.cn.scaleMargins.bottom * this.At() + this.co : this.cn.scaleMargins.top * this.At() + this.uo;
    }
    No() {
      return this.Oo() ? this.cn.scaleMargins.top * this.At() + this.uo : this.cn.scaleMargins.bottom * this.At() + this.co;
    }
    Fo() {
      this.ao.oo || (this.ao.oo = true, this.h_());
    }
    Ro() {
      this.ho = null;
    }
    To(t, i) {
      if (this.Fo(), this.Ni()) return 0;
      t = this.eo() && t ? an(t, this.Mo) : t;
      const n = b(this.zh()), s = this.No() + (this.Lo() - 1) * (t - n.Th()) / n.Rh();
      return this.Wo(s);
    }
    Co(t, i) {
      if (this.Fo(), this.Ni()) return 0;
      const n = this.Wo(t), s = b(this.zh()), e2 = s.Th() + s.Rh() * ((n - this.No()) / (this.Lo() - 1));
      return this.eo() ? on(e2, this.Mo) : e2;
    }
    Ao() {
      this.mo = null, this.yo.Qa();
    }
    h_() {
      const t = this.ao._o;
      if (null === t) return;
      let i = null;
      const n = this.e_();
      let s = 0, e2 = 0;
      for (const r3 of n) {
        if (!r3.yt()) continue;
        const n2 = r3.Ct();
        if (null === n2) continue;
        const h3 = r3.Al(t.Vs(), t.ui());
        let l2 = h3 && h3.zh();
        if (null !== l2) {
          switch (this.cn.mode) {
            case 1:
              l2 = _n(l2, this.Mo);
              break;
            case 2:
              l2 = rn(l2, n2.Vt);
              break;
            case 3:
              l2 = ln(l2, n2.Vt);
          }
          if (i = null === i ? l2 : i.ts(b(l2)), null !== h3) {
            const t2 = h3.Lh();
            null !== t2 && (s = Math.max(s, t2.above), e2 = Math.max(e2, t2.below));
          }
        }
      }
      if (s === this.uo && e2 === this.co || (this.uo = s, this.co = e2, this.mo = null, this.Ro()), null !== i) {
        if (i.Th() === i.Ph()) {
          const t2 = this.s_(), n2 = 5 * (null === t2 || this.gh() || this.Vo() ? 1 : t2.pa());
          this.eo() && (i = un(i, this.Mo)), i = new Ri(i.Th() - n2, i.Ph() + n2), this.eo() && (i = _n(i, this.Mo));
        }
        if (this.eo()) {
          const t2 = un(i, this.Mo), n2 = cn(t2);
          if (r2 = n2, h2 = this.Mo, r2.Ha !== h2.Ha || r2.$a !== h2.$a) {
            const s2 = null !== this.lo ? un(this.lo, this.Mo) : null;
            this.Mo = n2, i = _n(t2, n2), null !== s2 && (this.lo = _n(s2, n2));
          }
        }
        this.Bo(i);
      } else null === this.Ah && (this.Bo(new Ri(-0.5, 0.5)), this.Mo = cn(null));
      var r2, h2;
      this.ao.oo = true;
    }
    jo() {
      return this.gh() ? en : this.Vo() ? hn : this.eo() ? (t) => an(t, this.Mo) : null;
    }
    l_(t, i, n) {
      return void 0 === i ? (void 0 === n && (n = this.ma()), n.format(t)) : i(t);
    }
    Fh(t, i) {
      return this.l_(t, this.ko.priceFormatter, i);
    }
    n_(t, i) {
      return this.l_(t, this.ko.percentageFormatter, i);
    }
  };
  var gn = class {
    constructor(t, i) {
      this.vo = [], this.a_ = /* @__PURE__ */ new Map(), this.ro = 0, this.o_ = 0, this.__ = 1e3, this.po = null, this.u_ = new D(), this.kl = t, this.$i = i, this.c_ = new nn(this);
      const n = i.W();
      this.d_ = this.f_("left", n.leftPriceScale), this.v_ = this.f_("right", n.rightPriceScale), this.d_.Io().l(this.p_.bind(this, this.d_), this), this.v_.Io().l(this.p_.bind(this, this.v_), this), this.m_(n);
    }
    m_(t) {
      if (t.leftPriceScale && this.d_.Hh(t.leftPriceScale), t.rightPriceScale && this.v_.Hh(t.rightPriceScale), t.localization && (this.d_.Pa(), this.v_.Pa()), t.overlayPriceScales) {
        const i = Array.from(this.a_.values());
        for (const n of i) {
          const i2 = b(n[0].Dt());
          i2.Hh(t.overlayPriceScales), t.localization && i2.Pa();
        }
      }
    }
    b_(t) {
      switch (t) {
        case "left":
          return this.d_;
        case "right":
          return this.v_;
      }
      return this.a_.has(t) ? m(this.a_.get(t))[0].Dt() : null;
    }
    S() {
      this.$t().w_().p(this), this.d_.Io().p(this), this.v_.Io().p(this), this.vo.forEach(((t) => {
        t.S && t.S();
      })), this.u_.m();
    }
    g_() {
      return this.__;
    }
    M_(t) {
      this.__ = t;
    }
    $t() {
      return this.$i;
    }
    Hi() {
      return this.o_;
    }
    At() {
      return this.ro;
    }
    x_(t) {
      this.o_ = t, this.S_();
    }
    zo(t) {
      this.ro = t, this.d_.zo(t), this.v_.zo(t), this.vo.forEach(((i) => {
        if (this.dr(i)) {
          const n = i.Dt();
          null !== n && n.zo(t);
        }
      })), this.S_();
    }
    Oa() {
      return this.vo;
    }
    dr(t) {
      const i = t.Dt();
      return null === i || this.d_ !== i && this.v_ !== i;
    }
    Uo(t, i, n) {
      const s = void 0 !== n ? n : this.y_().k_ + 1;
      this.C_(t, i, s);
    }
    Yo(t) {
      const i = this.vo.indexOf(t);
      p(-1 !== i, "removeDataSource: invalid data source"), this.vo.splice(i, 1);
      const n = b(t.Dt()).Ta();
      if (this.a_.has(n)) {
        const i2 = m(this.a_.get(n)), s2 = i2.indexOf(t);
        -1 !== s2 && (i2.splice(s2, 1), 0 === i2.length && this.a_.delete(n));
      }
      const s = t.Dt();
      s && s.Oa().indexOf(t) >= 0 && s.Yo(t), null !== s && (s.qo(), this.T_(s)), this.po = null;
    }
    pr(t) {
      return t === this.d_ ? "left" : t === this.v_ ? "right" : "overlay";
    }
    P_() {
      return this.d_;
    }
    R_() {
      return this.v_;
    }
    D_(t, i) {
      t.Ko(i);
    }
    V_(t, i) {
      t.Go(i), this.S_();
    }
    O_(t) {
      t.Jo();
    }
    B_(t, i) {
      t.Qo(i);
    }
    A_(t, i) {
      t.t_(i), this.S_();
    }
    I_(t) {
      t.i_();
    }
    S_() {
      this.vo.forEach(((t) => {
        t.Vn();
      }));
    }
    vn() {
      let t = null;
      return this.$i.W().rightPriceScale.visible && 0 !== this.v_.Oa().length ? t = this.v_ : this.$i.W().leftPriceScale.visible && 0 !== this.d_.Oa().length ? t = this.d_ : 0 !== this.vo.length && (t = this.vo[0].Dt()), null === t && (t = this.v_), t;
    }
    vr() {
      let t = null;
      return this.$i.W().rightPriceScale.visible ? t = this.v_ : this.$i.W().leftPriceScale.visible && (t = this.d_), t;
    }
    T_(t) {
      null !== t && t.Do() && this.z_(t);
    }
    L_(t) {
      const i = this.kl.Zs();
      t.Po({ Wn: true }), null !== i && t.r_(i), this.S_();
    }
    E_() {
      this.z_(this.d_), this.z_(this.v_);
    }
    N_() {
      this.T_(this.d_), this.T_(this.v_), this.vo.forEach(((t) => {
        this.dr(t) && this.T_(t.Dt());
      })), this.S_(), this.$i.$h();
    }
    $o() {
      return null === this.po && (this.po = vn(this.vo)), this.po;
    }
    F_() {
      return this.u_;
    }
    W_() {
      return this.c_;
    }
    z_(t) {
      const i = t.e_();
      if (i && i.length > 0 && !this.kl.Ni()) {
        const i2 = this.kl.Zs();
        null !== i2 && t.r_(i2);
      }
      t.Vn();
    }
    y_() {
      const t = this.$o();
      if (0 === t.length) return { j_: 0, k_: 0 };
      let i = 0, n = 0;
      for (let s = 0; s < t.length; s++) {
        const e2 = t[s].Xi();
        null !== e2 && (e2 < i && (i = e2), e2 > n && (n = e2));
      }
      return { j_: i, k_: n };
    }
    C_(t, i, n) {
      let s = this.b_(i);
      if (null === s && (s = this.f_(i, this.$i.W().overlayPriceScales)), this.vo.push(t), !_t(i)) {
        const n2 = this.a_.get(i) || [];
        n2.push(t), this.a_.set(i, n2);
      }
      s.Uo(t), t.Gi(s), t.Ki(n), this.T_(s), this.po = null;
    }
    p_(t, i, n) {
      i.yr !== n.yr && this.z_(t);
    }
    f_(t, i) {
      const n = Object.assign({ visible: true, autoScale: true }, z(i)), s = new wn(t, n, this.$i.W().layout, this.$i.W().localization);
      return s.zo(this.At()), s;
    }
  };
  var Mn = class {
    constructor(t, i, n = 50) {
      this.Xe = 0, this.Ke = 1, this.Ge = 1, this.Qe = /* @__PURE__ */ new Map(), this.Je = /* @__PURE__ */ new Map(), this.H_ = t, this.U_ = i, this.tr = n;
    }
    q_(t) {
      const i = t.time, n = this.U_.cacheKey(i), s = this.Qe.get(n);
      if (void 0 !== s) return s.Y_;
      if (this.Xe === this.tr) {
        const t2 = this.Je.get(this.Ge);
        this.Je.delete(this.Ge), this.Qe.delete(m(t2)), this.Ge++, this.Xe--;
      }
      const e2 = this.H_(t);
      return this.Qe.set(n, { Y_: e2, er: this.Ke }), this.Je.set(this.Ke, n), this.Xe++, this.Ke++, e2;
    }
  };
  var xn = class {
    constructor(t, i) {
      p(t <= i, "right should be >= left"), this.Z_ = t, this.X_ = i;
    }
    Vs() {
      return this.Z_;
    }
    ui() {
      return this.X_;
    }
    K_() {
      return this.X_ - this.Z_ + 1;
    }
    Xr(t) {
      return this.Z_ <= t && t <= this.X_;
    }
    yh(t) {
      return this.Z_ === t.Vs() && this.X_ === t.ui();
    }
  };
  function Sn(t, i) {
    return null === t || null === i ? t === i : t.yh(i);
  }
  var kn = class {
    constructor() {
      this.G_ = /* @__PURE__ */ new Map(), this.Qe = null, this.J_ = false;
    }
    Q_(t) {
      this.J_ = t, this.Qe = null;
    }
    tu(t, i) {
      this.iu(i), this.Qe = null;
      for (let n = i; n < t.length; ++n) {
        const i2 = t[n];
        let s = this.G_.get(i2.timeWeight);
        void 0 === s && (s = [], this.G_.set(i2.timeWeight, s)), s.push({ index: n, time: i2.time, weight: i2.timeWeight, originalTime: i2.originalTime });
      }
    }
    nu(t, i) {
      const n = Math.ceil(i / t);
      return null !== this.Qe && this.Qe.su === n || (this.Qe = { ja: this.eu(n), su: n }), this.Qe.ja;
    }
    iu(t) {
      if (0 === t) return void this.G_.clear();
      const i = [];
      this.G_.forEach(((n, s) => {
        t <= n[0].index ? i.push(s) : n.splice(Bt(n, t, ((i2) => i2.index < t)), 1 / 0);
      }));
      for (const t2 of i) this.G_.delete(t2);
    }
    eu(t) {
      let i = [];
      for (const n of Array.from(this.G_.keys()).sort(((t2, i2) => i2 - t2))) {
        if (!this.G_.get(n)) continue;
        const s = i;
        i = [];
        const e2 = s.length;
        let r2 = 0;
        const h2 = m(this.G_.get(n)), l2 = h2.length;
        let a2 = 1 / 0, o2 = -1 / 0;
        for (let n2 = 0; n2 < l2; n2++) {
          const l3 = h2[n2], _2 = l3.index;
          for (; r2 < e2; ) {
            const t2 = s[r2], n3 = t2.index;
            if (!(n3 < _2)) {
              a2 = n3;
              break;
            }
            r2++, i.push(t2), o2 = n3, a2 = 1 / 0;
          }
          if (a2 - _2 >= t && _2 - o2 >= t) i.push(l3), o2 = _2;
          else if (this.J_) return s;
        }
        for (; r2 < e2; r2++) i.push(s[r2]);
      }
      return i;
    }
  };
  var yn = class _yn {
    constructor(t) {
      this.ru = t;
    }
    hu() {
      return null === this.ru ? null : new xn(Math.floor(this.ru.Vs()), Math.ceil(this.ru.ui()));
    }
    lu() {
      return this.ru;
    }
    static au() {
      return new _yn(null);
    }
  };
  function Cn(t, i) {
    return t.weight > i.weight ? t : i;
  }
  var Tn = class {
    constructor(t, i, n, s) {
      this.o_ = 0, this.ou = null, this._u = [], this.wo = null, this.bo = null, this.uu = new kn(), this.cu = /* @__PURE__ */ new Map(), this.du = yn.au(), this.fu = true, this.vu = new D(), this.pu = new D(), this.mu = new D(), this.bu = null, this.wu = null, this.gu = [], this.cn = i, this.ko = n, this.Mu = i.rightOffset, this.xu = i.barSpacing, this.$i = t, this.U_ = s, this.Su(), this.uu.Q_(i.uniformDistribution);
    }
    W() {
      return this.cn;
    }
    ku(t) {
      V(this.ko, t), this.yu(), this.Su();
    }
    Hh(t, i) {
      var n;
      V(this.cn, t), this.cn.fixLeftEdge && this.Cu(), this.cn.fixRightEdge && this.Tu(), void 0 !== t.barSpacing && this.$i.Gn(t.barSpacing), void 0 !== t.rightOffset && this.$i.Jn(t.rightOffset), void 0 !== t.minBarSpacing && this.$i.Gn(null !== (n = t.barSpacing) && void 0 !== n ? n : this.xu), this.yu(), this.Su(), this.mu.m();
    }
    mn(t) {
      var i, n;
      return null !== (n = null === (i = this._u[t]) || void 0 === i ? void 0 : i.time) && void 0 !== n ? n : null;
    }
    Ui(t) {
      var i;
      return null !== (i = this._u[t]) && void 0 !== i ? i : null;
    }
    Da(t, i) {
      if (this._u.length < 1) return null;
      if (this.U_.key(t) > this.U_.key(this._u[this._u.length - 1].time)) return i ? this._u.length - 1 : null;
      const n = Bt(this._u, this.U_.key(t), ((t2, i2) => this.U_.key(t2.time) < i2));
      return this.U_.key(t) < this.U_.key(this._u[n].time) ? i ? n : null : n;
    }
    Ni() {
      return 0 === this.o_ || 0 === this._u.length || null === this.ou;
    }
    Ra() {
      return this._u.length > 0;
    }
    Zs() {
      return this.Pu(), this.du.hu();
    }
    Ru() {
      return this.Pu(), this.du.lu();
    }
    Du() {
      const t = this.Zs();
      if (null === t) return null;
      const i = { from: t.Vs(), to: t.ui() };
      return this.Vu(i);
    }
    Vu(t) {
      const i = Math.round(t.from), n = Math.round(t.to), s = b(this.Ou()), e2 = b(this.Bu());
      return { from: b(this.Ui(Math.max(s, i))), to: b(this.Ui(Math.min(e2, n))) };
    }
    Au(t) {
      return { from: b(this.Da(t.from, true)), to: b(this.Da(t.to, true)) };
    }
    Hi() {
      return this.o_;
    }
    x_(t) {
      if (!isFinite(t) || t <= 0) return;
      if (this.o_ === t) return;
      const i = this.Ru(), n = this.o_;
      if (this.o_ = t, this.fu = true, this.cn.lockVisibleTimeRangeOnResize && 0 !== n) {
        const i2 = this.xu * t / n;
        this.xu = i2;
      }
      if (this.cn.fixLeftEdge && null !== i && i.Vs() <= 0) {
        const i2 = n - t;
        this.Mu -= Math.round(i2 / this.xu) + 1, this.fu = true;
      }
      this.Iu(), this.zu();
    }
    It(t) {
      if (this.Ni() || !B(t)) return 0;
      const i = this.Lu() + this.Mu - t;
      return this.o_ - (i + 0.5) * this.xu - 1;
    }
    Js(t, i) {
      const n = this.Lu(), s = void 0 === i ? 0 : i.from, e2 = void 0 === i ? t.length : i.to;
      for (let i2 = s; i2 < e2; i2++) {
        const s2 = t[i2].ot, e3 = n + this.Mu - s2, r2 = this.o_ - (e3 + 0.5) * this.xu - 1;
        t[i2].nt = r2;
      }
    }
    Eu(t) {
      return Math.ceil(this.Nu(t));
    }
    Jn(t) {
      this.fu = true, this.Mu = t, this.zu(), this.$i.Fu(), this.$i.$h();
    }
    he() {
      return this.xu;
    }
    Gn(t) {
      this.Wu(t), this.zu(), this.$i.Fu(), this.$i.$h();
    }
    ju() {
      return this.Mu;
    }
    ja() {
      if (this.Ni()) return null;
      if (null !== this.wu) return this.wu;
      const t = this.xu, i = 5 * (this.$i.W().layout.fontSize + 4) / 8 * (this.cn.tickMarkMaxCharacterLength || 8), n = Math.round(i / t), s = b(this.Zs()), e2 = Math.max(s.Vs(), s.Vs() - n), r2 = Math.max(s.ui(), s.ui() - n), h2 = this.uu.nu(t, i), l2 = this.Ou() + n, a2 = this.Bu() - n, o2 = this.Hu(), _2 = this.cn.fixLeftEdge || o2, u2 = this.cn.fixRightEdge || o2;
      let c2 = 0;
      for (const t2 of h2) {
        if (!(e2 <= t2.index && t2.index <= r2)) continue;
        let n2;
        c2 < this.gu.length ? (n2 = this.gu[c2], n2.coord = this.It(t2.index), n2.label = this.$u(t2), n2.weight = t2.weight) : (n2 = { needAlignCoordinate: false, coord: this.It(t2.index), label: this.$u(t2), weight: t2.weight }, this.gu.push(n2)), this.xu > i / 2 && !o2 ? n2.needAlignCoordinate = false : n2.needAlignCoordinate = _2 && t2.index <= l2 || u2 && t2.index >= a2, c2++;
      }
      return this.gu.length = c2, this.wu = this.gu, this.gu;
    }
    Uu() {
      this.fu = true, this.Gn(this.cn.barSpacing), this.Jn(this.cn.rightOffset);
    }
    qu(t) {
      this.fu = true, this.ou = t, this.zu(), this.Cu();
    }
    Yu(t, i) {
      const n = this.Nu(t), s = this.he(), e2 = s + i * (s / 10);
      this.Gn(e2), this.cn.rightBarStaysOnScroll || this.Jn(this.ju() + (n - this.Nu(t)));
    }
    Ko(t) {
      this.wo && this.i_(), null === this.bo && null === this.bu && (this.Ni() || (this.bo = t, this.Zu()));
    }
    Go(t) {
      if (null === this.bu) return;
      const i = kt(this.o_ - t, 0, this.o_), n = kt(this.o_ - b(this.bo), 0, this.o_);
      0 !== i && 0 !== n && this.Gn(this.bu.he * i / n);
    }
    Jo() {
      null !== this.bo && (this.bo = null, this.Xu());
    }
    Qo(t) {
      null === this.wo && null === this.bu && (this.Ni() || (this.wo = t, this.Zu()));
    }
    t_(t) {
      if (null === this.wo) return;
      const i = (this.wo - t) / this.he();
      this.Mu = b(this.bu).ju + i, this.fu = true, this.zu();
    }
    i_() {
      null !== this.wo && (this.wo = null, this.Xu());
    }
    Ku() {
      this.Gu(this.cn.rightOffset);
    }
    Gu(t, i = 400) {
      if (!isFinite(t)) throw new RangeError("offset is required and must be finite number");
      if (!isFinite(i) || i <= 0) throw new RangeError("animationDuration (optional) must be finite positive number");
      const n = this.Mu, s = performance.now();
      this.$i.Zn({ Ju: (t2) => (t2 - s) / i >= 1, Qu: (e2) => {
        const r2 = (e2 - s) / i;
        return r2 >= 1 ? t : n + (t - n) * r2;
      } });
    }
    bt(t, i) {
      this.fu = true, this._u = t, this.uu.tu(t, i), this.zu();
    }
    tc() {
      return this.vu;
    }
    nc() {
      return this.pu;
    }
    sc() {
      return this.mu;
    }
    Lu() {
      return this.ou || 0;
    }
    ec(t) {
      const i = t.K_();
      this.Wu(this.o_ / i), this.Mu = t.ui() - this.Lu(), this.zu(), this.fu = true, this.$i.Fu(), this.$i.$h();
    }
    rc() {
      const t = this.Ou(), i = this.Bu();
      null !== t && null !== i && this.ec(new xn(t, i + this.cn.rightOffset));
    }
    hc(t) {
      const i = new xn(t.from, t.to);
      this.ec(i);
    }
    qi(t) {
      return void 0 !== this.ko.timeFormatter ? this.ko.timeFormatter(t.originalTime) : this.U_.formatHorzItem(t.time);
    }
    Hu() {
      const { handleScroll: t, handleScale: i } = this.$i.W();
      return !(t.horzTouchDrag || t.mouseWheel || t.pressedMouseMove || t.vertTouchDrag || i.axisDoubleClickReset.time || i.axisPressedMouseMove.time || i.mouseWheel || i.pinch);
    }
    Ou() {
      return 0 === this._u.length ? null : 0;
    }
    Bu() {
      return 0 === this._u.length ? null : this._u.length - 1;
    }
    lc(t) {
      return (this.o_ - 1 - t) / this.xu;
    }
    Nu(t) {
      const i = this.lc(t), n = this.Lu() + this.Mu - i;
      return Math.round(1e6 * n) / 1e6;
    }
    Wu(t) {
      const i = this.xu;
      this.xu = t, this.Iu(), i !== this.xu && (this.fu = true, this.ac());
    }
    Pu() {
      if (!this.fu) return;
      if (this.fu = false, this.Ni()) return void this.oc(yn.au());
      const t = this.Lu(), i = this.o_ / this.xu, n = this.Mu + t, s = new xn(n - i + 1, n);
      this.oc(new yn(s));
    }
    Iu() {
      const t = this._c();
      if (this.xu < t && (this.xu = t, this.fu = true), 0 !== this.o_) {
        const t2 = 0.5 * this.o_;
        this.xu > t2 && (this.xu = t2, this.fu = true);
      }
    }
    _c() {
      return this.cn.fixLeftEdge && this.cn.fixRightEdge && 0 !== this._u.length ? this.o_ / this._u.length : this.cn.minBarSpacing;
    }
    zu() {
      const t = this.uc();
      this.Mu > t && (this.Mu = t, this.fu = true);
      const i = this.cc();
      null !== i && this.Mu < i && (this.Mu = i, this.fu = true);
    }
    cc() {
      const t = this.Ou(), i = this.ou;
      if (null === t || null === i) return null;
      return t - i - 1 + (this.cn.fixLeftEdge ? this.o_ / this.xu : Math.min(2, this._u.length));
    }
    uc() {
      return this.cn.fixRightEdge ? 0 : this.o_ / this.xu - Math.min(2, this._u.length);
    }
    Zu() {
      this.bu = { he: this.he(), ju: this.ju() };
    }
    Xu() {
      this.bu = null;
    }
    $u(t) {
      let i = this.cu.get(t.weight);
      return void 0 === i && (i = new Mn(((t2) => this.dc(t2)), this.U_), this.cu.set(t.weight, i)), i.q_(t);
    }
    dc(t) {
      return this.U_.formatTickmark(t, this.ko);
    }
    oc(t) {
      const i = this.du;
      this.du = t, Sn(i.hu(), this.du.hu()) || this.vu.m(), Sn(i.lu(), this.du.lu()) || this.pu.m(), this.ac();
    }
    ac() {
      this.wu = null;
    }
    yu() {
      this.ac(), this.cu.clear();
    }
    Su() {
      this.U_.updateFormatter(this.ko);
    }
    Cu() {
      if (!this.cn.fixLeftEdge) return;
      const t = this.Ou();
      if (null === t) return;
      const i = this.Zs();
      if (null === i) return;
      const n = i.Vs() - t;
      if (n < 0) {
        const t2 = this.Mu - n - 1;
        this.Jn(t2);
      }
      this.Iu();
    }
    Tu() {
      this.zu(), this.Iu();
    }
  };
  var Pn = class {
    X(t, i, n) {
      t.useMediaCoordinateSpace(((t2) => this.K(t2, i, n)));
    }
    wl(t, i, n) {
      t.useMediaCoordinateSpace(((t2) => this.fc(t2, i, n)));
    }
    fc(t, i, n) {
    }
  };
  var Rn = class extends Pn {
    constructor(t) {
      super(), this.vc = /* @__PURE__ */ new Map(), this.zt = t;
    }
    K(t) {
    }
    fc(t) {
      if (!this.zt.yt) return;
      const { context: i, mediaSize: n } = t;
      let s = 0;
      for (const t2 of this.zt.mc) {
        if (0 === t2.Kt.length) continue;
        i.font = t2.R;
        const e3 = this.bc(i, t2.Kt);
        e3 > n.width ? t2.Yu = n.width / e3 : t2.Yu = 1, s += t2.wc * t2.Yu;
      }
      let e2 = 0;
      switch (this.zt.gc) {
        case "top":
          e2 = 0;
          break;
        case "center":
          e2 = Math.max((n.height - s) / 2, 0);
          break;
        case "bottom":
          e2 = Math.max(n.height - s, 0);
      }
      i.fillStyle = this.zt.V;
      for (const t2 of this.zt.mc) {
        i.save();
        let s2 = 0;
        switch (this.zt.Mc) {
          case "left":
            i.textAlign = "left", s2 = t2.wc / 2;
            break;
          case "center":
            i.textAlign = "center", s2 = n.width / 2;
            break;
          case "right":
            i.textAlign = "right", s2 = n.width - 1 - t2.wc / 2;
        }
        i.translate(s2, e2), i.textBaseline = "top", i.font = t2.R, i.scale(t2.Yu, t2.Yu), i.fillText(t2.Kt, 0, t2.xc), i.restore(), e2 += t2.wc * t2.Yu;
      }
    }
    bc(t, i) {
      const n = this.Sc(t.font);
      let s = n.get(i);
      return void 0 === s && (s = t.measureText(i).width, n.set(i, s)), s;
    }
    Sc(t) {
      let i = this.vc.get(t);
      return void 0 === i && (i = /* @__PURE__ */ new Map(), this.vc.set(t, i)), i;
    }
  };
  var Dn = class {
    constructor(t) {
      this.ft = true, this.Ft = { yt: false, V: "", mc: [], gc: "center", Mc: "center" }, this.Wt = new Rn(this.Ft), this.jt = t;
    }
    bt() {
      this.ft = true;
    }
    gt() {
      return this.ft && (this.Mt(), this.ft = false), this.Wt;
    }
    Mt() {
      const t = this.jt.W(), i = this.Ft;
      i.yt = t.visible, i.yt && (i.V = t.color, i.Mc = t.horzAlign, i.gc = t.vertAlign, i.mc = [{ Kt: t.text, R: F(t.fontSize, t.fontFamily, t.fontStyle), wc: 1.2 * t.fontSize, xc: 0, Yu: 0 }]);
    }
  };
  var Vn = class extends lt {
    constructor(t, i) {
      super(), this.cn = i, this.wn = new Dn(this);
    }
    Rn() {
      return [];
    }
    Pn() {
      return [this.wn];
    }
    W() {
      return this.cn;
    }
    Vn() {
      this.wn.bt();
    }
  };
  var On;
  var Bn;
  var An;
  var In;
  var zn;
  !(function(t) {
    t[t.OnTouchEnd = 0] = "OnTouchEnd", t[t.OnNextTap = 1] = "OnNextTap";
  })(On || (On = {}));
  var Ln = class {
    constructor(t, i, n) {
      this.kc = [], this.yc = [], this.o_ = 0, this.Cc = null, this.Tc = new D(), this.Pc = new D(), this.Rc = null, this.Dc = t, this.cn = i, this.U_ = n, this.Vc = new W(this), this.kl = new Tn(this, i.timeScale, this.cn.localization, n), this.vt = new ot(this, i.crosshair), this.Oc = new Ji(i.crosshair), this.Bc = new Vn(this, i.watermark), this.Ac(), this.kc[0].M_(2e3), this.Ic = this.zc(0), this.Lc = this.zc(1);
    }
    Xl() {
      this.Ec(ut.es());
    }
    $h() {
      this.Ec(ut.ss());
    }
    aa() {
      this.Ec(new ut(1));
    }
    Kl(t) {
      const i = this.Nc(t);
      this.Ec(i);
    }
    Fc() {
      return this.Cc;
    }
    Wc(t) {
      const i = this.Cc;
      this.Cc = t, null !== i && this.Kl(i.jc), null !== t && this.Kl(t.jc);
    }
    W() {
      return this.cn;
    }
    Hh(t) {
      V(this.cn, t), this.kc.forEach(((i) => i.m_(t))), void 0 !== t.timeScale && this.kl.Hh(t.timeScale), void 0 !== t.localization && this.kl.ku(t.localization), (t.leftPriceScale || t.rightPriceScale) && this.Tc.m(), this.Ic = this.zc(0), this.Lc = this.zc(1), this.Xl();
    }
    Hc(t, i) {
      if ("left" === t) return void this.Hh({ leftPriceScale: i });
      if ("right" === t) return void this.Hh({ rightPriceScale: i });
      const n = this.$c(t);
      null !== n && (n.Dt.Hh(i), this.Tc.m());
    }
    $c(t) {
      for (const i of this.kc) {
        const n = i.b_(t);
        if (null !== n) return { Ht: i, Dt: n };
      }
      return null;
    }
    St() {
      return this.kl;
    }
    Uc() {
      return this.kc;
    }
    qc() {
      return this.Bc;
    }
    Yc() {
      return this.vt;
    }
    Zc() {
      return this.Pc;
    }
    Xc(t, i) {
      t.zo(i), this.Fu();
    }
    x_(t) {
      this.o_ = t, this.kl.x_(this.o_), this.kc.forEach(((i) => i.x_(t))), this.Fu();
    }
    Ac(t) {
      const i = new gn(this.kl, this);
      void 0 !== t ? this.kc.splice(t, 0, i) : this.kc.push(i);
      const n = void 0 === t ? this.kc.length - 1 : t, s = ut.es();
      return s.Nn(n, { Fn: 0, Wn: true }), this.Ec(s), i;
    }
    D_(t, i, n) {
      t.D_(i, n);
    }
    V_(t, i, n) {
      t.V_(i, n), this.Gl(), this.Ec(this.Kc(t, 2));
    }
    O_(t, i) {
      t.O_(i), this.Ec(this.Kc(t, 2));
    }
    B_(t, i, n) {
      i.Do() || t.B_(i, n);
    }
    A_(t, i, n) {
      i.Do() || (t.A_(i, n), this.Gl(), this.Ec(this.Kc(t, 2)));
    }
    I_(t, i) {
      i.Do() || (t.I_(i), this.Ec(this.Kc(t, 2)));
    }
    L_(t, i) {
      t.L_(i), this.Ec(this.Kc(t, 2));
    }
    Gc(t) {
      this.kl.Ko(t);
    }
    Jc(t, i) {
      const n = this.St();
      if (n.Ni() || 0 === i) return;
      const s = n.Hi();
      t = Math.max(1, Math.min(t, s)), n.Yu(t, i), this.Fu();
    }
    Qc(t) {
      this.td(0), this.nd(t), this.sd();
    }
    ed(t) {
      this.kl.Go(t), this.Fu();
    }
    rd() {
      this.kl.Jo(), this.$h();
    }
    td(t) {
      this.kl.Qo(t);
    }
    nd(t) {
      this.kl.t_(t), this.Fu();
    }
    sd() {
      this.kl.i_(), this.$h();
    }
    wt() {
      return this.yc;
    }
    hd(t, i, n, s, e2) {
      this.vt.gn(t, i);
      let r2 = NaN, h2 = this.kl.Eu(t);
      const l2 = this.kl.Zs();
      null !== l2 && (h2 = Math.min(Math.max(l2.Vs(), h2), l2.ui()));
      const a2 = s.vn(), o2 = a2.Ct();
      null !== o2 && (r2 = a2.pn(i, o2)), r2 = this.Oc.Va(r2, h2, s), this.vt.kn(h2, r2, s), this.aa(), e2 || this.Pc.m(this.vt.xt(), { x: t, y: i }, n);
    }
    ld(t, i, n) {
      const s = n.vn(), e2 = s.Ct(), r2 = s.Rt(t, b(e2)), h2 = this.kl.Da(i, true), l2 = this.kl.It(b(h2));
      this.hd(l2, r2, null, n, true);
    }
    ad(t) {
      this.Yc().Cn(), this.aa(), t || this.Pc.m(null, null, null);
    }
    Gl() {
      const t = this.vt.Ht();
      if (null !== t) {
        const i = this.vt.xn(), n = this.vt.Sn();
        this.hd(i, n, null, t);
      }
      this.vt.Vn();
    }
    od(t, i, n) {
      const s = this.kl.mn(0);
      void 0 !== i && void 0 !== n && this.kl.bt(i, n);
      const e2 = this.kl.mn(0), r2 = this.kl.Lu(), h2 = this.kl.Zs();
      if (null !== h2 && null !== s && null !== e2) {
        const i2 = h2.Xr(r2), l2 = this.U_.key(s) > this.U_.key(e2), a2 = null !== t && t > r2 && !l2, o2 = this.kl.W().allowShiftVisibleRangeOnWhitespaceReplacement, _2 = i2 && (!(void 0 === n) || o2) && this.kl.W().shiftVisibleRangeOnNewBar;
        if (a2 && !_2) {
          const i3 = t - r2;
          this.kl.Jn(this.kl.ju() - i3);
        }
      }
      this.kl.qu(t);
    }
    ta(t) {
      null !== t && t.N_();
    }
    cr(t) {
      const i = this.kc.find(((i2) => i2.$o().includes(t)));
      return void 0 === i ? null : i;
    }
    Fu() {
      this.Bc.Vn(), this.kc.forEach(((t) => t.N_())), this.Gl();
    }
    S() {
      this.kc.forEach(((t) => t.S())), this.kc.length = 0, this.cn.localization.priceFormatter = void 0, this.cn.localization.percentageFormatter = void 0, this.cn.localization.timeFormatter = void 0;
    }
    _d() {
      return this.Vc;
    }
    mr() {
      return this.Vc.W();
    }
    w_() {
      return this.Tc;
    }
    ud(t, i, n) {
      const s = this.kc[0], e2 = this.dd(i, t, s, n);
      return this.yc.push(e2), 1 === this.yc.length ? this.Xl() : this.$h(), e2;
    }
    fd(t) {
      const i = this.cr(t), n = this.yc.indexOf(t);
      p(-1 !== n, "Series not found"), this.yc.splice(n, 1), b(i).Yo(t), t.S && t.S();
    }
    Zl(t, i) {
      const n = b(this.cr(t));
      n.Yo(t);
      const s = this.$c(i);
      if (null === s) {
        const s2 = t.Xi();
        n.Uo(t, i, s2);
      } else {
        const e2 = s.Ht === n ? t.Xi() : void 0;
        s.Ht.Uo(t, i, e2);
      }
    }
    rc() {
      const t = ut.ss();
      t.$n(), this.Ec(t);
    }
    vd(t) {
      const i = ut.ss();
      i.Yn(t), this.Ec(i);
    }
    Kn() {
      const t = ut.ss();
      t.Kn(), this.Ec(t);
    }
    Gn(t) {
      const i = ut.ss();
      i.Gn(t), this.Ec(i);
    }
    Jn(t) {
      const i = ut.ss();
      i.Jn(t), this.Ec(i);
    }
    Zn(t) {
      const i = ut.ss();
      i.Zn(t), this.Ec(i);
    }
    Un() {
      const t = ut.ss();
      t.Un(), this.Ec(t);
    }
    pd() {
      return this.cn.rightPriceScale.visible ? "right" : "left";
    }
    md() {
      return this.Lc;
    }
    q() {
      return this.Ic;
    }
    Bt(t) {
      const i = this.Lc, n = this.Ic;
      if (i === n) return i;
      if (t = Math.max(0, Math.min(100, Math.round(100 * t))), null === this.Rc || this.Rc.Ts !== n || this.Rc.Ps !== i) this.Rc = { Ts: n, Ps: i, bd: /* @__PURE__ */ new Map() };
      else {
        const i2 = this.Rc.bd.get(t);
        if (void 0 !== i2) return i2;
      }
      const s = (function(t2, i2, n2) {
        const [s2, e2, r2, h2] = T(t2), [l2, a2, o2, _2] = T(i2), u2 = [M(s2 + n2 * (l2 - s2)), M(e2 + n2 * (a2 - e2)), M(r2 + n2 * (o2 - r2)), x(h2 + n2 * (_2 - h2))];
        return `rgba(${u2[0]}, ${u2[1]}, ${u2[2]}, ${u2[3]})`;
      })(n, i, t / 100);
      return this.Rc.bd.set(t, s), s;
    }
    Kc(t, i) {
      const n = new ut(i);
      if (null !== t) {
        const s = this.kc.indexOf(t);
        n.Nn(s, { Fn: i });
      }
      return n;
    }
    Nc(t, i) {
      return void 0 === i && (i = 2), this.Kc(this.cr(t), i);
    }
    Ec(t) {
      this.Dc && this.Dc(t), this.kc.forEach(((t2) => t2.W_().Uh().bt()));
    }
    dd(t, i, n, s) {
      const e2 = new Gi(this, t, i, n, s), r2 = void 0 !== t.priceScaleId ? t.priceScaleId : this.pd();
      return n.Uo(e2, r2), _t(r2) || e2.Hh(t), e2;
    }
    zc(t) {
      const i = this.cn.layout;
      return "gradient" === i.background.type ? 0 === t ? i.background.topColor : i.background.bottomColor : i.background.color;
    }
  };
  function En(t) {
    return !O(t) && !A(t);
  }
  function Nn(t) {
    return O(t);
  }
  !(function(t) {
    t[t.Disabled = 0] = "Disabled", t[t.Continuous = 1] = "Continuous", t[t.OnDataUpdate = 2] = "OnDataUpdate";
  })(Bn || (Bn = {})), (function(t) {
    t[t.LastBar = 0] = "LastBar", t[t.LastVisible = 1] = "LastVisible";
  })(An || (An = {})), (function(t) {
    t.Solid = "solid", t.VerticalGradient = "gradient";
  })(In || (In = {})), (function(t) {
    t[t.Year = 0] = "Year", t[t.Month = 1] = "Month", t[t.DayOfMonth = 2] = "DayOfMonth", t[t.Time = 3] = "Time", t[t.TimeWithSeconds = 4] = "TimeWithSeconds";
  })(zn || (zn = {}));
  var Fn = (t) => t.getUTCFullYear();
  function Wn(t, i, n) {
    return i.replace(/yyyy/g, ((t2) => dt(Fn(t2), 4))(t)).replace(/yy/g, ((t2) => dt(Fn(t2) % 100, 2))(t)).replace(/MMMM/g, ((t2, i2) => new Date(t2.getUTCFullYear(), t2.getUTCMonth(), 1).toLocaleString(i2, { month: "long" }))(t, n)).replace(/MMM/g, ((t2, i2) => new Date(t2.getUTCFullYear(), t2.getUTCMonth(), 1).toLocaleString(i2, { month: "short" }))(t, n)).replace(/MM/g, ((t2) => dt(((t3) => t3.getUTCMonth() + 1)(t2), 2))(t)).replace(/dd/g, ((t2) => dt(((t3) => t3.getUTCDate())(t2), 2))(t));
  }
  var jn = class {
    constructor(t = "yyyy-MM-dd", i = "default") {
      this.wd = t, this.gd = i;
    }
    q_(t) {
      return Wn(t, this.wd, this.gd);
    }
  };
  var Hn = class {
    constructor(t) {
      this.Md = t || "%h:%m:%s";
    }
    q_(t) {
      return this.Md.replace("%h", dt(t.getUTCHours(), 2)).replace("%m", dt(t.getUTCMinutes(), 2)).replace("%s", dt(t.getUTCSeconds(), 2));
    }
  };
  var $n = { xd: "yyyy-MM-dd", Sd: "%h:%m:%s", kd: " ", yd: "default" };
  var Un = class {
    constructor(t = {}) {
      const i = Object.assign(Object.assign({}, $n), t);
      this.Cd = new jn(i.xd, i.yd), this.Td = new Hn(i.Sd), this.Pd = i.kd;
    }
    q_(t) {
      return `${this.Cd.q_(t)}${this.Pd}${this.Td.q_(t)}`;
    }
  };
  function qn(t) {
    return 60 * t * 60 * 1e3;
  }
  function Yn(t) {
    return 60 * t * 1e3;
  }
  var Zn = [{ Rd: (Xn = 1, 1e3 * Xn), Dd: 10 }, { Rd: Yn(1), Dd: 20 }, { Rd: Yn(5), Dd: 21 }, { Rd: Yn(30), Dd: 22 }, { Rd: qn(1), Dd: 30 }, { Rd: qn(3), Dd: 31 }, { Rd: qn(6), Dd: 32 }, { Rd: qn(12), Dd: 33 }];
  var Xn;
  function Kn(t, i) {
    if (t.getUTCFullYear() !== i.getUTCFullYear()) return 70;
    if (t.getUTCMonth() !== i.getUTCMonth()) return 60;
    if (t.getUTCDate() !== i.getUTCDate()) return 50;
    for (let n = Zn.length - 1; n >= 0; --n) if (Math.floor(i.getTime() / Zn[n].Rd) !== Math.floor(t.getTime() / Zn[n].Rd)) return Zn[n].Dd;
    return 0;
  }
  function Gn(t) {
    let i = t;
    if (A(t) && (i = Qn(t)), !En(i)) throw new Error("time must be of type BusinessDay");
    const n = new Date(Date.UTC(i.year, i.month - 1, i.day, 0, 0, 0, 0));
    return { Vd: Math.round(n.getTime() / 1e3), Od: i };
  }
  function Jn(t) {
    if (!Nn(t)) throw new Error("time must be of type isUTCTimestamp");
    return { Vd: t };
  }
  function Qn(t) {
    const i = new Date(t);
    if (isNaN(i.getTime())) throw new Error(`Invalid date string=${t}, expected format=yyyy-mm-dd`);
    return { day: i.getUTCDate(), month: i.getUTCMonth() + 1, year: i.getUTCFullYear() };
  }
  function ts(t) {
    A(t.time) && (t.time = Qn(t.time));
  }
  var is = class {
    options() {
      return this.cn;
    }
    setOptions(t) {
      this.cn = t, this.updateFormatter(t.localization);
    }
    preprocessData(t) {
      Array.isArray(t) ? (function(t2) {
        t2.forEach(ts);
      })(t) : ts(t);
    }
    createConverterToInternalObj(t) {
      return b((function(t2) {
        return 0 === t2.length ? null : En(t2[0].time) || A(t2[0].time) ? Gn : Jn;
      })(t));
    }
    key(t) {
      return "object" == typeof t && "Vd" in t ? t.Vd : this.key(this.convertHorzItemToInternal(t));
    }
    cacheKey(t) {
      const i = t;
      return void 0 === i.Od ? new Date(1e3 * i.Vd).getTime() : new Date(Date.UTC(i.Od.year, i.Od.month - 1, i.Od.day)).getTime();
    }
    convertHorzItemToInternal(t) {
      return Nn(i = t) ? Jn(i) : En(i) ? Gn(i) : Gn(Qn(i));
      var i;
    }
    updateFormatter(t) {
      if (!this.cn) return;
      const i = t.dateFormat;
      this.cn.timeScale.timeVisible ? this.Bd = new Un({ xd: i, Sd: this.cn.timeScale.secondsVisible ? "%h:%m:%s" : "%h:%m", kd: "   ", yd: t.locale }) : this.Bd = new jn(i, t.locale);
    }
    formatHorzItem(t) {
      const i = t;
      return this.Bd.q_(new Date(1e3 * i.Vd));
    }
    formatTickmark(t, i) {
      const n = (function(t2, i2, n2) {
        switch (t2) {
          case 0:
          case 10:
            return i2 ? n2 ? 4 : 3 : 2;
          case 20:
          case 21:
          case 22:
          case 30:
          case 31:
          case 32:
          case 33:
            return i2 ? 3 : 2;
          case 50:
            return 2;
          case 60:
            return 1;
          case 70:
            return 0;
        }
      })(t.weight, this.cn.timeScale.timeVisible, this.cn.timeScale.secondsVisible), s = this.cn.timeScale;
      if (void 0 !== s.tickMarkFormatter) {
        const e2 = s.tickMarkFormatter(t.originalTime, n, i.locale);
        if (null !== e2) return e2;
      }
      return (function(t2, i2, n2) {
        const s2 = {};
        switch (i2) {
          case 0:
            s2.year = "numeric";
            break;
          case 1:
            s2.month = "short";
            break;
          case 2:
            s2.day = "numeric";
            break;
          case 3:
            s2.hour12 = false, s2.hour = "2-digit", s2.minute = "2-digit";
            break;
          case 4:
            s2.hour12 = false, s2.hour = "2-digit", s2.minute = "2-digit", s2.second = "2-digit";
        }
        const e2 = void 0 === t2.Od ? new Date(1e3 * t2.Vd) : new Date(Date.UTC(t2.Od.year, t2.Od.month - 1, t2.Od.day));
        return new Date(e2.getUTCFullYear(), e2.getUTCMonth(), e2.getUTCDate(), e2.getUTCHours(), e2.getUTCMinutes(), e2.getUTCSeconds(), e2.getUTCMilliseconds()).toLocaleString(n2, s2);
      })(t.time, n, i.locale);
    }
    maxTickMarkWeight(t) {
      let i = t.reduce(Cn, t[0]).weight;
      return i > 30 && i < 50 && (i = 30), i;
    }
    fillWeightsForPoints(t, i) {
      !(function(t2, i2 = 0) {
        if (0 === t2.length) return;
        let n = 0 === i2 ? null : t2[i2 - 1].time.Vd, s = null !== n ? new Date(1e3 * n) : null, e2 = 0;
        for (let r2 = i2; r2 < t2.length; ++r2) {
          const i3 = t2[r2], h2 = new Date(1e3 * i3.time.Vd);
          null !== s && (i3.timeWeight = Kn(h2, s)), e2 += i3.time.Vd - (n || i3.time.Vd), n = i3.time.Vd, s = h2;
        }
        if (0 === i2 && t2.length > 1) {
          const i3 = Math.ceil(e2 / (t2.length - 1)), n2 = new Date(1e3 * (t2[0].time.Vd - i3));
          t2[0].timeWeight = Kn(new Date(1e3 * t2[0].time.Vd), n2);
        }
      })(t, i);
    }
    static Ad(t) {
      return V({ localization: { dateFormat: "dd MMM 'yy" } }, null != t ? t : {});
    }
  };
  var ns = "undefined" != typeof window;
  function ss() {
    return !!ns && window.navigator.userAgent.toLowerCase().indexOf("firefox") > -1;
  }
  function es() {
    return !!ns && /iPhone|iPad|iPod/.test(window.navigator.platform);
  }
  function rs(t) {
    return t + t % 2;
  }
  function hs(t, i) {
    return t.Id - i.Id;
  }
  function ls(t, i, n) {
    const s = (t.Id - i.Id) / (t.ot - i.ot);
    return Math.sign(s) * Math.min(Math.abs(s), n);
  }
  var as = class {
    constructor(t, i, n, s) {
      this.zd = null, this.Ld = null, this.Ed = null, this.Nd = null, this.Fd = null, this.Wd = 0, this.jd = 0, this.Hd = t, this.$d = i, this.Ud = n, this.rs = s;
    }
    qd(t, i) {
      if (null !== this.zd) {
        if (this.zd.ot === i) return void (this.zd.Id = t);
        if (Math.abs(this.zd.Id - t) < this.rs) return;
      }
      this.Nd = this.Ed, this.Ed = this.Ld, this.Ld = this.zd, this.zd = { ot: i, Id: t };
    }
    Dr(t, i) {
      if (null === this.zd || null === this.Ld) return;
      if (i - this.zd.ot > 50) return;
      let n = 0;
      const s = ls(this.zd, this.Ld, this.$d), e2 = hs(this.zd, this.Ld), r2 = [s], h2 = [e2];
      if (n += e2, null !== this.Ed) {
        const t2 = ls(this.Ld, this.Ed, this.$d);
        if (Math.sign(t2) === Math.sign(s)) {
          const i2 = hs(this.Ld, this.Ed);
          if (r2.push(t2), h2.push(i2), n += i2, null !== this.Nd) {
            const t3 = ls(this.Ed, this.Nd, this.$d);
            if (Math.sign(t3) === Math.sign(s)) {
              const i3 = hs(this.Ed, this.Nd);
              r2.push(t3), h2.push(i3), n += i3;
            }
          }
        }
      }
      let l2 = 0;
      for (let t2 = 0; t2 < r2.length; ++t2) l2 += h2[t2] / n * r2[t2];
      Math.abs(l2) < this.Hd || (this.Fd = { Id: t, ot: i }, this.jd = l2, this.Wd = (function(t2, i2) {
        const n2 = Math.log(i2);
        return Math.log(1 * n2 / -t2) / n2;
      })(Math.abs(l2), this.Ud));
    }
    Qu(t) {
      const i = b(this.Fd), n = t - i.ot;
      return i.Id + this.jd * (Math.pow(this.Ud, n) - 1) / Math.log(this.Ud);
    }
    Ju(t) {
      return null === this.Fd || this.Yd(t) === this.Wd;
    }
    Yd(t) {
      const i = t - b(this.Fd).ot;
      return Math.min(i, this.Wd);
    }
  };
  var os = class {
    constructor(t, i) {
      this.Zd = void 0, this.Xd = void 0, this.Kd = void 0, this.en = false, this.Gd = t, this.Jd = i, this.Qd();
    }
    bt() {
      this.Qd();
    }
    tf() {
      this.Zd && this.Gd.removeChild(this.Zd), this.Xd && this.Gd.removeChild(this.Xd), this.Zd = void 0, this.Xd = void 0;
    }
    if() {
      return this.en !== this.nf() || this.Kd !== this.sf();
    }
    sf() {
      return P(T(this.Jd.W().layout.textColor)) > 160 ? "dark" : "light";
    }
    nf() {
      return this.Jd.W().layout.attributionLogo;
    }
    ef() {
      const t = new URL(location.href);
      return t.hostname ? "&utm_source=" + t.hostname + t.pathname : "";
    }
    Qd() {
      this.if() && (this.tf(), this.en = this.nf(), this.en && (this.Kd = this.sf(), this.Xd = document.createElement("style"), this.Xd.innerText = "a#tv-attr-logo{--fill:#131722;--stroke:#fff;position:absolute;left:10px;bottom:10px;height:19px;width:35px;margin:0;padding:0;border:0;z-index:3;}a#tv-attr-logo[data-dark]{--fill:#D1D4DC;--stroke:#131722;}", this.Zd = document.createElement("a"), this.Zd.href = `https://www.tradingview.com/?utm_medium=lwc-link&utm_campaign=lwc-chart${this.ef()}`, this.Zd.title = "Charting by TradingView", this.Zd.id = "tv-attr-logo", this.Zd.target = "_blank", this.Zd.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 35 19" width="35" height="19" fill="none"><g fill-rule="evenodd" clip-path="url(#a)" clip-rule="evenodd"><path fill="var(--stroke)" d="M2 0H0v10h6v9h21.4l.5-1.3 6-15 1-2.7H23.7l-.5 1.3-.2.6a5 5 0 0 0-7-.9V0H2Zm20 17h4l5.2-13 .8-2h-7l-1 2.5-.2.5-1.5 3.8-.3.7V17Zm-.8-10a3 3 0 0 0 .7-2.7A3 3 0 1 0 16.8 7h4.4ZM14 7V2H2v6h6v9h4V7h2Z"/><path fill="var(--fill)" d="M14 2H2v6h6v9h6V2Zm12 15h-7l6-15h7l-6 15Zm-7-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/></g><defs><clipPath id="a"><path fill="var(--stroke)" d="M0 0h35v19H0z"/></clipPath></defs></svg>', this.Zd.toggleAttribute("data-dark", "dark" === this.Kd), this.Gd.appendChild(this.Xd), this.Gd.appendChild(this.Zd)));
    }
  };
  function _s(t, n) {
    const s = b(t.ownerDocument).createElement("canvas");
    t.appendChild(s);
    const e2 = bindTo(s, { type: "device-pixel-content-box", options: { allowResizeObserver: false }, transform: (t2, i) => ({ width: Math.max(t2.width, i.width), height: Math.max(t2.height, i.height) }) });
    return e2.resizeCanvasElement(n), e2;
  }
  function us(t) {
    var i;
    t.width = 1, t.height = 1, null === (i = t.getContext("2d")) || void 0 === i || i.clearRect(0, 0, 1, 1);
  }
  function cs(t, i, n, s) {
    t.wl && t.wl(i, n, s);
  }
  function ds(t, i, n, s) {
    t.X(i, n, s);
  }
  function fs(t, i, n, s) {
    const e2 = t(n, s);
    for (const t2 of e2) {
      const n2 = t2.gt();
      null !== n2 && i(n2);
    }
  }
  function vs(t) {
    ns && void 0 !== window.chrome && t.addEventListener("mousedown", ((t2) => {
      if (1 === t2.button) return t2.preventDefault(), false;
    }));
  }
  var ps = class {
    constructor(t, i, n) {
      this.rf = 0, this.hf = null, this.lf = { nt: Number.NEGATIVE_INFINITY, st: Number.POSITIVE_INFINITY }, this.af = 0, this._f = null, this.uf = { nt: Number.NEGATIVE_INFINITY, st: Number.POSITIVE_INFINITY }, this.cf = null, this.df = false, this.ff = null, this.vf = null, this.pf = false, this.mf = false, this.bf = false, this.wf = null, this.gf = null, this.Mf = null, this.xf = null, this.Sf = null, this.kf = null, this.yf = null, this.Cf = 0, this.Tf = false, this.Pf = false, this.Rf = false, this.Df = 0, this.Vf = null, this.Of = !es(), this.Bf = (t2) => {
        this.Af(t2);
      }, this.If = (t2) => {
        if (this.zf(t2)) {
          const i2 = this.Lf(t2);
          if (++this.af, this._f && this.af > 1) {
            const { Ef: n2 } = this.Nf(ws(t2), this.uf);
            n2 < 30 && !this.bf && this.Ff(i2, this.jf.Wf), this.Hf();
          }
        } else {
          const i2 = this.Lf(t2);
          if (++this.rf, this.hf && this.rf > 1) {
            const { Ef: n2 } = this.Nf(ws(t2), this.lf);
            n2 < 5 && !this.mf && this.$f(i2, this.jf.Uf), this.qf();
          }
        }
      }, this.Yf = t, this.jf = i, this.cn = n, this.Zf();
    }
    S() {
      null !== this.wf && (this.wf(), this.wf = null), null !== this.gf && (this.gf(), this.gf = null), null !== this.xf && (this.xf(), this.xf = null), null !== this.Sf && (this.Sf(), this.Sf = null), null !== this.kf && (this.kf(), this.kf = null), null !== this.Mf && (this.Mf(), this.Mf = null), this.Xf(), this.qf();
    }
    Kf(t) {
      this.xf && this.xf();
      const i = this.Gf.bind(this);
      if (this.xf = () => {
        this.Yf.removeEventListener("mousemove", i);
      }, this.Yf.addEventListener("mousemove", i), this.zf(t)) return;
      const n = this.Lf(t);
      this.$f(n, this.jf.Jf), this.Of = true;
    }
    qf() {
      null !== this.hf && clearTimeout(this.hf), this.rf = 0, this.hf = null, this.lf = { nt: Number.NEGATIVE_INFINITY, st: Number.POSITIVE_INFINITY };
    }
    Hf() {
      null !== this._f && clearTimeout(this._f), this.af = 0, this._f = null, this.uf = { nt: Number.NEGATIVE_INFINITY, st: Number.POSITIVE_INFINITY };
    }
    Gf(t) {
      if (this.Rf || null !== this.vf) return;
      if (this.zf(t)) return;
      const i = this.Lf(t);
      this.$f(i, this.jf.Qf), this.Of = true;
    }
    tv(t) {
      const i = Ms(t.changedTouches, b(this.Vf));
      if (null === i) return;
      if (this.Df = gs(t), null !== this.yf) return;
      if (this.Pf) return;
      this.Tf = true;
      const n = this.Nf(ws(i), b(this.vf)), { iv: s, nv: e2, Ef: r2 } = n;
      if (this.pf || !(r2 < 5)) {
        if (!this.pf) {
          const t2 = 0.5 * s, i2 = e2 >= t2 && !this.cn.sv(), n2 = t2 > e2 && !this.cn.ev();
          i2 || n2 || (this.Pf = true), this.pf = true, this.bf = true, this.Xf(), this.Hf();
        }
        if (!this.Pf) {
          const n2 = this.Lf(t, i);
          this.Ff(n2, this.jf.rv), bs(t);
        }
      }
    }
    hv(t) {
      if (0 !== t.button) return;
      const i = this.Nf(ws(t), b(this.ff)), { Ef: n } = i;
      if (n >= 5 && (this.mf = true, this.qf()), this.mf) {
        const i2 = this.Lf(t);
        this.$f(i2, this.jf.lv);
      }
    }
    Nf(t, i) {
      const n = Math.abs(i.nt - t.nt), s = Math.abs(i.st - t.st);
      return { iv: n, nv: s, Ef: n + s };
    }
    av(t) {
      let i = Ms(t.changedTouches, b(this.Vf));
      if (null === i && 0 === t.touches.length && (i = t.changedTouches[0]), null === i) return;
      this.Vf = null, this.Df = gs(t), this.Xf(), this.vf = null, this.kf && (this.kf(), this.kf = null);
      const n = this.Lf(t, i);
      if (this.Ff(n, this.jf.ov), ++this.af, this._f && this.af > 1) {
        const { Ef: t2 } = this.Nf(ws(i), this.uf);
        t2 < 30 && !this.bf && this.Ff(n, this.jf.Wf), this.Hf();
      } else this.bf || (this.Ff(n, this.jf._v), this.jf._v && bs(t));
      0 === this.af && bs(t), 0 === t.touches.length && this.df && (this.df = false, bs(t));
    }
    Af(t) {
      if (0 !== t.button) return;
      const i = this.Lf(t);
      if (this.ff = null, this.Rf = false, this.Sf && (this.Sf(), this.Sf = null), ss()) {
        this.Yf.ownerDocument.documentElement.removeEventListener("mouseleave", this.Bf);
      }
      if (!this.zf(t)) if (this.$f(i, this.jf.uv), ++this.rf, this.hf && this.rf > 1) {
        const { Ef: n } = this.Nf(ws(t), this.lf);
        n < 5 && !this.mf && this.$f(i, this.jf.Uf), this.qf();
      } else this.mf || this.$f(i, this.jf.cv);
    }
    Xf() {
      null !== this.cf && (clearTimeout(this.cf), this.cf = null);
    }
    dv(t) {
      if (null !== this.Vf) return;
      const i = t.changedTouches[0];
      this.Vf = i.identifier, this.Df = gs(t);
      const n = this.Yf.ownerDocument.documentElement;
      this.bf = false, this.pf = false, this.Pf = false, this.vf = ws(i), this.kf && (this.kf(), this.kf = null);
      {
        const i2 = this.tv.bind(this), s2 = this.av.bind(this);
        this.kf = () => {
          n.removeEventListener("touchmove", i2), n.removeEventListener("touchend", s2);
        }, n.addEventListener("touchmove", i2, { passive: false }), n.addEventListener("touchend", s2, { passive: false }), this.Xf(), this.cf = setTimeout(this.fv.bind(this, t), 240);
      }
      const s = this.Lf(t, i);
      this.Ff(s, this.jf.vv), this._f || (this.af = 0, this._f = setTimeout(this.Hf.bind(this), 500), this.uf = ws(i));
    }
    pv(t) {
      if (0 !== t.button) return;
      const i = this.Yf.ownerDocument.documentElement;
      ss() && i.addEventListener("mouseleave", this.Bf), this.mf = false, this.ff = ws(t), this.Sf && (this.Sf(), this.Sf = null);
      {
        const t2 = this.hv.bind(this), n2 = this.Af.bind(this);
        this.Sf = () => {
          i.removeEventListener("mousemove", t2), i.removeEventListener("mouseup", n2);
        }, i.addEventListener("mousemove", t2), i.addEventListener("mouseup", n2);
      }
      if (this.Rf = true, this.zf(t)) return;
      const n = this.Lf(t);
      this.$f(n, this.jf.mv), this.hf || (this.rf = 0, this.hf = setTimeout(this.qf.bind(this), 500), this.lf = ws(t));
    }
    Zf() {
      this.Yf.addEventListener("mouseenter", this.Kf.bind(this)), this.Yf.addEventListener("touchcancel", this.Xf.bind(this));
      {
        const t = this.Yf.ownerDocument, i = (t2) => {
          this.jf.bv && (t2.composed && this.Yf.contains(t2.composedPath()[0]) || t2.target && this.Yf.contains(t2.target) || this.jf.bv());
        };
        this.gf = () => {
          t.removeEventListener("touchstart", i);
        }, this.wf = () => {
          t.removeEventListener("mousedown", i);
        }, t.addEventListener("mousedown", i), t.addEventListener("touchstart", i, { passive: true });
      }
      es() && (this.Mf = () => {
        this.Yf.removeEventListener("dblclick", this.If);
      }, this.Yf.addEventListener("dblclick", this.If)), this.Yf.addEventListener("mouseleave", this.wv.bind(this)), this.Yf.addEventListener("touchstart", this.dv.bind(this), { passive: true }), vs(this.Yf), this.Yf.addEventListener("mousedown", this.pv.bind(this)), this.gv(), this.Yf.addEventListener("touchmove", (() => {
      }), { passive: false });
    }
    gv() {
      void 0 === this.jf.Mv && void 0 === this.jf.xv && void 0 === this.jf.Sv || (this.Yf.addEventListener("touchstart", ((t) => this.kv(t.touches)), { passive: true }), this.Yf.addEventListener("touchmove", ((t) => {
        if (2 === t.touches.length && null !== this.yf && void 0 !== this.jf.xv) {
          const i = ms(t.touches[0], t.touches[1]) / this.Cf;
          this.jf.xv(this.yf, i), bs(t);
        }
      }), { passive: false }), this.Yf.addEventListener("touchend", ((t) => {
        this.kv(t.touches);
      })));
    }
    kv(t) {
      1 === t.length && (this.Tf = false), 2 !== t.length || this.Tf || this.df ? this.yv() : this.Cv(t);
    }
    Cv(t) {
      const i = this.Yf.getBoundingClientRect() || { left: 0, top: 0 };
      this.yf = { nt: (t[0].clientX - i.left + (t[1].clientX - i.left)) / 2, st: (t[0].clientY - i.top + (t[1].clientY - i.top)) / 2 }, this.Cf = ms(t[0], t[1]), void 0 !== this.jf.Mv && this.jf.Mv(), this.Xf();
    }
    yv() {
      null !== this.yf && (this.yf = null, void 0 !== this.jf.Sv && this.jf.Sv());
    }
    wv(t) {
      if (this.xf && this.xf(), this.zf(t)) return;
      if (!this.Of) return;
      const i = this.Lf(t);
      this.$f(i, this.jf.Tv), this.Of = !es();
    }
    fv(t) {
      const i = Ms(t.touches, b(this.Vf));
      if (null === i) return;
      const n = this.Lf(t, i);
      this.Ff(n, this.jf.Pv), this.bf = true, this.df = true;
    }
    zf(t) {
      return t.sourceCapabilities && void 0 !== t.sourceCapabilities.firesTouchEvents ? t.sourceCapabilities.firesTouchEvents : gs(t) < this.Df + 500;
    }
    Ff(t, i) {
      i && i.call(this.jf, t);
    }
    $f(t, i) {
      i && i.call(this.jf, t);
    }
    Lf(t, i) {
      const n = i || t, s = this.Yf.getBoundingClientRect() || { left: 0, top: 0 };
      return { clientX: n.clientX, clientY: n.clientY, pageX: n.pageX, pageY: n.pageY, screenX: n.screenX, screenY: n.screenY, localX: n.clientX - s.left, localY: n.clientY - s.top, ctrlKey: t.ctrlKey, altKey: t.altKey, shiftKey: t.shiftKey, metaKey: t.metaKey, Rv: !t.type.startsWith("mouse") && "contextmenu" !== t.type && "click" !== t.type, Dv: t.type, Vv: n.target, Ov: t.view, Bv: () => {
        "touchstart" !== t.type && bs(t);
      } };
    }
  };
  function ms(t, i) {
    const n = t.clientX - i.clientX, s = t.clientY - i.clientY;
    return Math.sqrt(n * n + s * s);
  }
  function bs(t) {
    t.cancelable && t.preventDefault();
  }
  function ws(t) {
    return { nt: t.pageX, st: t.pageY };
  }
  function gs(t) {
    return t.timeStamp || performance.now();
  }
  function Ms(t, i) {
    for (let n = 0; n < t.length; ++n) if (t[n].identifier === i) return t[n];
    return null;
  }
  function xs(t) {
    return { jc: t.jc, Av: { wr: t.Iv.externalId }, zv: t.Iv.cursorStyle };
  }
  function Ss(t, i, n) {
    for (const s of t) {
      const t2 = s.gt();
      if (null !== t2 && t2.br) {
        const e2 = t2.br(i, n);
        if (null !== e2) return { Ov: s, Av: e2 };
      }
    }
    return null;
  }
  function ks(t, i) {
    return (n) => {
      var s, e2, r2, h2;
      return (null !== (e2 = null === (s = n.Dt()) || void 0 === s ? void 0 : s.Ta()) && void 0 !== e2 ? e2 : "") !== i ? [] : null !== (h2 = null === (r2 = n.ca) || void 0 === r2 ? void 0 : r2.call(n, t)) && void 0 !== h2 ? h2 : [];
    };
  }
  function ys(t, i, n, s) {
    if (!t.length) return;
    let e2 = 0;
    const r2 = n / 2, h2 = t[0].At(s, true);
    let l2 = 1 === i ? r2 - (t[0].Vi() - h2 / 2) : t[0].Vi() - h2 / 2 - r2;
    l2 = Math.max(0, l2);
    for (let r3 = 1; r3 < t.length; r3++) {
      const h3 = t[r3], a2 = t[r3 - 1], o2 = a2.At(s, false), _2 = h3.Vi(), u2 = a2.Vi();
      if (1 === i ? _2 > u2 - o2 : _2 < u2 + o2) {
        const s2 = u2 - o2 * i;
        h3.Oi(s2);
        const r4 = s2 - i * o2 / 2;
        if ((1 === i ? r4 < 0 : r4 > n) && l2 > 0) {
          const s3 = 1 === i ? -1 - r4 : r4 - n, h4 = Math.min(s3, l2);
          for (let n2 = e2; n2 < t.length; n2++) t[n2].Oi(t[n2].Vi() + i * h4);
          l2 -= h4;
        }
      } else e2 = r3, l2 = 1 === i ? u2 - o2 - _2 : _2 - (u2 + o2);
    }
  }
  var Cs = class {
    constructor(i, n, s, e2) {
      this.Li = null, this.Lv = null, this.Ev = false, this.Nv = new ni(200), this.Jr = null, this.Fv = 0, this.Wv = false, this.jv = () => {
        this.Wv || this.tn.Hv().$t().$h();
      }, this.$v = () => {
        this.Wv || this.tn.Hv().$t().$h();
      }, this.tn = i, this.cn = n, this.So = n.layout, this.Vc = s, this.Uv = "left" === e2, this.qv = ks("normal", e2), this.Yv = ks("top", e2), this.Zv = ks("bottom", e2), this.Xv = document.createElement("div"), this.Xv.style.height = "100%", this.Xv.style.overflow = "hidden", this.Xv.style.width = "25px", this.Xv.style.left = "0", this.Xv.style.position = "relative", this.Kv = _s(this.Xv, size({ width: 16, height: 16 })), this.Kv.subscribeSuggestedBitmapSizeChanged(this.jv);
      const r2 = this.Kv.canvasElement;
      r2.style.position = "absolute", r2.style.zIndex = "1", r2.style.left = "0", r2.style.top = "0", this.Gv = _s(this.Xv, size({ width: 16, height: 16 })), this.Gv.subscribeSuggestedBitmapSizeChanged(this.$v);
      const h2 = this.Gv.canvasElement;
      h2.style.position = "absolute", h2.style.zIndex = "2", h2.style.left = "0", h2.style.top = "0";
      const l2 = { mv: this.Jv.bind(this), vv: this.Jv.bind(this), lv: this.Qv.bind(this), rv: this.Qv.bind(this), bv: this.tp.bind(this), uv: this.ip.bind(this), ov: this.ip.bind(this), Uf: this.np.bind(this), Wf: this.np.bind(this), Jf: this.sp.bind(this), Tv: this.ep.bind(this) };
      this.rp = new ps(this.Gv.canvasElement, l2, { sv: () => !this.cn.handleScroll.vertTouchDrag, ev: () => true });
    }
    S() {
      this.rp.S(), this.Gv.unsubscribeSuggestedBitmapSizeChanged(this.$v), us(this.Gv.canvasElement), this.Gv.dispose(), this.Kv.unsubscribeSuggestedBitmapSizeChanged(this.jv), us(this.Kv.canvasElement), this.Kv.dispose(), null !== this.Li && this.Li.Xo().p(this), this.Li = null;
    }
    hp() {
      return this.Xv;
    }
    P() {
      return this.So.fontSize;
    }
    lp() {
      const t = this.Vc.W();
      return this.Jr !== t.R && (this.Nv.ir(), this.Jr = t.R), t;
    }
    ap() {
      if (null === this.Li) return 0;
      let t = 0;
      const i = this.lp(), n = b(this.Kv.canvasElement.getContext("2d"));
      n.save();
      const s = this.Li.ja();
      n.font = this.op(), s.length > 0 && (t = Math.max(this.Nv.xi(n, s[0].no), this.Nv.xi(n, s[s.length - 1].no)));
      const e2 = this._p();
      for (let i2 = e2.length; i2--; ) {
        const s2 = this.Nv.xi(n, e2[i2].Kt());
        s2 > t && (t = s2);
      }
      const r2 = this.Li.Ct();
      if (null !== r2 && null !== this.Lv) {
        const i2 = this.Li.pn(1, r2), s2 = this.Li.pn(this.Lv.height - 2, r2);
        t = Math.max(t, this.Nv.xi(n, this.Li.Fi(Math.floor(Math.min(i2, s2)) + 0.11111111111111, r2)), this.Nv.xi(n, this.Li.Fi(Math.ceil(Math.max(i2, s2)) - 0.11111111111111, r2)));
      }
      n.restore();
      const h2 = t || 34;
      return rs(Math.ceil(i.C + i.T + i.A + i.I + 5 + h2));
    }
    up(t) {
      null !== this.Lv && equalSizes(this.Lv, t) || (this.Lv = t, this.Wv = true, this.Kv.resizeCanvasElement(t), this.Gv.resizeCanvasElement(t), this.Wv = false, this.Xv.style.width = `${t.width}px`, this.Xv.style.height = `${t.height}px`);
    }
    cp() {
      return b(this.Lv).width;
    }
    Gi(t) {
      this.Li !== t && (null !== this.Li && this.Li.Xo().p(this), this.Li = t, t.Xo().l(this.do.bind(this), this));
    }
    Dt() {
      return this.Li;
    }
    ir() {
      const t = this.tn.dp();
      this.tn.Hv().$t().L_(t, b(this.Dt()));
    }
    fp(t) {
      if (null === this.Lv) return;
      if (1 !== t) {
        this.vp(), this.Kv.applySuggestedBitmapSize();
        const t2 = tryCreateCanvasRenderingTarget2D(this.Kv);
        null !== t2 && (t2.useBitmapCoordinateSpace(((t3) => {
          this.pp(t3), this.Ae(t3);
        })), this.tn.mp(t2, this.Zv), this.bp(t2), this.tn.mp(t2, this.qv), this.wp(t2));
      }
      this.Gv.applySuggestedBitmapSize();
      const i = tryCreateCanvasRenderingTarget2D(this.Gv);
      null !== i && (i.useBitmapCoordinateSpace((({ context: t2, bitmapSize: i2 }) => {
        t2.clearRect(0, 0, i2.width, i2.height);
      })), this.gp(i), this.tn.mp(i, this.Yv));
    }
    Mp() {
      return this.Kv.bitmapSize;
    }
    xp(t, i, n) {
      const s = this.Mp();
      s.width > 0 && s.height > 0 && t.drawImage(this.Kv.canvasElement, i, n);
    }
    bt() {
      var t;
      null === (t = this.Li) || void 0 === t || t.ja();
    }
    Jv(t) {
      if (null === this.Li || this.Li.Ni() || !this.cn.handleScale.axisPressedMouseMove.price) return;
      const i = this.tn.Hv().$t(), n = this.tn.dp();
      this.Ev = true, i.D_(n, this.Li, t.localY);
    }
    Qv(t) {
      if (null === this.Li || !this.cn.handleScale.axisPressedMouseMove.price) return;
      const i = this.tn.Hv().$t(), n = this.tn.dp(), s = this.Li;
      i.V_(n, s, t.localY);
    }
    tp() {
      if (null === this.Li || !this.cn.handleScale.axisPressedMouseMove.price) return;
      const t = this.tn.Hv().$t(), i = this.tn.dp(), n = this.Li;
      this.Ev && (this.Ev = false, t.O_(i, n));
    }
    ip(t) {
      if (null === this.Li || !this.cn.handleScale.axisPressedMouseMove.price) return;
      const i = this.tn.Hv().$t(), n = this.tn.dp();
      this.Ev = false, i.O_(n, this.Li);
    }
    np(t) {
      this.cn.handleScale.axisDoubleClickReset.price && this.ir();
    }
    sp(t) {
      if (null === this.Li) return;
      !this.tn.Hv().$t().W().handleScale.axisPressedMouseMove.price || this.Li.gh() || this.Li.Vo() || this.Sp(1);
    }
    ep(t) {
      this.Sp(0);
    }
    _p() {
      const t = [], i = null === this.Li ? void 0 : this.Li;
      return ((n) => {
        for (let s = 0; s < n.length; ++s) {
          const e2 = n[s].Rn(this.tn.dp(), i);
          for (let i2 = 0; i2 < e2.length; i2++) t.push(e2[i2]);
        }
      })(this.tn.dp().$o()), t;
    }
    pp({ context: t, bitmapSize: i }) {
      const { width: n, height: s } = i, e2 = this.tn.dp().$t(), r2 = e2.q(), h2 = e2.md();
      r2 === h2 ? G(t, 0, 0, n, s, r2) : tt(t, 0, 0, n, s, r2, h2);
    }
    Ae({ context: t, bitmapSize: i, horizontalPixelRatio: n }) {
      if (null === this.Lv || null === this.Li || !this.Li.W().borderVisible) return;
      t.fillStyle = this.Li.W().borderColor;
      const s = Math.max(1, Math.floor(this.lp().C * n));
      let e2;
      e2 = this.Uv ? i.width - s : 0, t.fillRect(e2, 0, s, i.height);
    }
    bp(t) {
      if (null === this.Lv || null === this.Li) return;
      const i = this.Li.ja(), n = this.Li.W(), s = this.lp(), e2 = this.Uv ? this.Lv.width - s.T : 0;
      n.borderVisible && n.ticksVisible && t.useBitmapCoordinateSpace((({ context: t2, horizontalPixelRatio: r2, verticalPixelRatio: h2 }) => {
        t2.fillStyle = n.borderColor;
        const l2 = Math.max(1, Math.floor(h2)), a2 = Math.floor(0.5 * h2), o2 = Math.round(s.T * r2);
        t2.beginPath();
        for (const n2 of i) t2.rect(Math.floor(e2 * r2), Math.round(n2.La * h2) - a2, o2, l2);
        t2.fill();
      })), t.useMediaCoordinateSpace((({ context: t2 }) => {
        var r2;
        t2.font = this.op(), t2.fillStyle = null !== (r2 = n.textColor) && void 0 !== r2 ? r2 : this.So.textColor, t2.textAlign = this.Uv ? "right" : "left", t2.textBaseline = "middle";
        const h2 = this.Uv ? Math.round(e2 - s.A) : Math.round(e2 + s.T + s.A), l2 = i.map(((i2) => this.Nv.Mi(t2, i2.no)));
        for (let n2 = i.length; n2--; ) {
          const s2 = i[n2];
          t2.fillText(s2.no, h2, s2.La + l2[n2]);
        }
      }));
    }
    vp() {
      if (null === this.Lv || null === this.Li) return;
      const t = [], i = this.Li.$o().slice(), n = this.tn.dp(), s = this.lp();
      this.Li === n.vr() && this.tn.dp().$o().forEach(((t2) => {
        n.dr(t2) && i.push(t2);
      }));
      const e2 = this.Li;
      i.forEach(((i2) => {
        i2.Rn(n, e2).forEach(((i3) => {
          i3.Oi(null), i3.Bi() && t.push(i3);
        }));
      })), t.forEach(((t2) => t2.Oi(t2.ki())));
      this.Li.W().alignLabels && this.kp(t, s);
    }
    kp(t, i) {
      if (null === this.Lv) return;
      const n = this.Lv.height / 2, s = t.filter(((t2) => t2.ki() <= n)), e2 = t.filter(((t2) => t2.ki() > n));
      s.sort(((t2, i2) => i2.ki() - t2.ki())), e2.sort(((t2, i2) => t2.ki() - i2.ki()));
      for (const n2 of t) {
        const t2 = Math.floor(n2.At(i) / 2), s2 = n2.ki();
        s2 > -t2 && s2 < t2 && n2.Oi(t2), s2 > this.Lv.height - t2 && s2 < this.Lv.height + t2 && n2.Oi(this.Lv.height - t2);
      }
      ys(s, 1, this.Lv.height, i), ys(e2, -1, this.Lv.height, i);
    }
    wp(t) {
      if (null === this.Lv) return;
      const i = this._p(), n = this.lp(), s = this.Uv ? "right" : "left";
      i.forEach(((i2) => {
        if (i2.Ai()) {
          i2.gt(b(this.Li)).X(t, n, this.Nv, s);
        }
      }));
    }
    gp(t) {
      if (null === this.Lv || null === this.Li) return;
      const i = this.tn.Hv().$t(), n = [], s = this.tn.dp(), e2 = i.Yc().Rn(s, this.Li);
      e2.length && n.push(e2);
      const r2 = this.lp(), h2 = this.Uv ? "right" : "left";
      n.forEach(((i2) => {
        i2.forEach(((i3) => {
          i3.gt(b(this.Li)).X(t, r2, this.Nv, h2);
        }));
      }));
    }
    Sp(t) {
      this.Xv.style.cursor = 1 === t ? "ns-resize" : "default";
    }
    do() {
      const t = this.ap();
      this.Fv < t && this.tn.Hv().$t().Xl(), this.Fv = t;
    }
    op() {
      return F(this.So.fontSize, this.So.fontFamily);
    }
  };
  function Ts(t, i) {
    var n, s;
    return null !== (s = null === (n = t._a) || void 0 === n ? void 0 : n.call(t, i)) && void 0 !== s ? s : [];
  }
  function Ps(t, i) {
    var n, s;
    return null !== (s = null === (n = t.Pn) || void 0 === n ? void 0 : n.call(t, i)) && void 0 !== s ? s : [];
  }
  function Rs(t, i) {
    var n, s;
    return null !== (s = null === (n = t.Ji) || void 0 === n ? void 0 : n.call(t, i)) && void 0 !== s ? s : [];
  }
  function Ds(t, i) {
    var n, s;
    return null !== (s = null === (n = t.la) || void 0 === n ? void 0 : n.call(t, i)) && void 0 !== s ? s : [];
  }
  var Vs = class _Vs {
    constructor(i, n) {
      this.Lv = size({ width: 0, height: 0 }), this.yp = null, this.Cp = null, this.Tp = null, this.Pp = null, this.Rp = false, this.Dp = new D(), this.Vp = new D(), this.Op = 0, this.Bp = false, this.Ap = null, this.Ip = false, this.zp = null, this.Lp = null, this.Wv = false, this.jv = () => {
        this.Wv || null === this.Ep || this.$i().$h();
      }, this.$v = () => {
        this.Wv || null === this.Ep || this.$i().$h();
      }, this.Jd = i, this.Ep = n, this.Ep.F_().l(this.Np.bind(this), this, true), this.Fp = document.createElement("td"), this.Fp.style.padding = "0", this.Fp.style.position = "relative";
      const s = document.createElement("div");
      s.style.width = "100%", s.style.height = "100%", s.style.position = "relative", s.style.overflow = "hidden", this.Wp = document.createElement("td"), this.Wp.style.padding = "0", this.jp = document.createElement("td"), this.jp.style.padding = "0", this.Fp.appendChild(s), this.Kv = _s(s, size({ width: 16, height: 16 })), this.Kv.subscribeSuggestedBitmapSizeChanged(this.jv);
      const e2 = this.Kv.canvasElement;
      e2.style.position = "absolute", e2.style.zIndex = "1", e2.style.left = "0", e2.style.top = "0", this.Gv = _s(s, size({ width: 16, height: 16 })), this.Gv.subscribeSuggestedBitmapSizeChanged(this.$v);
      const r2 = this.Gv.canvasElement;
      r2.style.position = "absolute", r2.style.zIndex = "2", r2.style.left = "0", r2.style.top = "0", this.Hp = document.createElement("tr"), this.Hp.appendChild(this.Wp), this.Hp.appendChild(this.Fp), this.Hp.appendChild(this.jp), this.$p(), this.rp = new ps(this.Gv.canvasElement, this, { sv: () => null === this.Ap && !this.Jd.W().handleScroll.vertTouchDrag, ev: () => null === this.Ap && !this.Jd.W().handleScroll.horzTouchDrag });
    }
    S() {
      null !== this.yp && this.yp.S(), null !== this.Cp && this.Cp.S(), this.Tp = null, this.Gv.unsubscribeSuggestedBitmapSizeChanged(this.$v), us(this.Gv.canvasElement), this.Gv.dispose(), this.Kv.unsubscribeSuggestedBitmapSizeChanged(this.jv), us(this.Kv.canvasElement), this.Kv.dispose(), null !== this.Ep && this.Ep.F_().p(this), this.rp.S();
    }
    dp() {
      return b(this.Ep);
    }
    Up(t) {
      var i, n;
      null !== this.Ep && this.Ep.F_().p(this), this.Ep = t, null !== this.Ep && this.Ep.F_().l(_Vs.prototype.Np.bind(this), this, true), this.$p(), this.Jd.qp().indexOf(this) === this.Jd.qp().length - 1 ? (this.Tp = null !== (i = this.Tp) && void 0 !== i ? i : new os(this.Fp, this.Jd), this.Tp.bt()) : (null === (n = this.Tp) || void 0 === n || n.tf(), this.Tp = null);
    }
    Hv() {
      return this.Jd;
    }
    hp() {
      return this.Hp;
    }
    $p() {
      if (null !== this.Ep && (this.Yp(), 0 !== this.$i().wt().length)) {
        if (null !== this.yp) {
          const t = this.Ep.P_();
          this.yp.Gi(b(t));
        }
        if (null !== this.Cp) {
          const t = this.Ep.R_();
          this.Cp.Gi(b(t));
        }
      }
    }
    Zp() {
      null !== this.yp && this.yp.bt(), null !== this.Cp && this.Cp.bt();
    }
    g_() {
      return null !== this.Ep ? this.Ep.g_() : 0;
    }
    M_(t) {
      this.Ep && this.Ep.M_(t);
    }
    Jf(t) {
      if (!this.Ep) return;
      this.Xp();
      const i = t.localX, n = t.localY;
      this.Kp(i, n, t);
    }
    mv(t) {
      this.Xp(), this.Gp(), this.Kp(t.localX, t.localY, t);
    }
    Qf(t) {
      var i;
      if (!this.Ep) return;
      this.Xp();
      const n = t.localX, s = t.localY;
      this.Kp(n, s, t);
      const e2 = this.br(n, s);
      this.Jd.Jp(null !== (i = null == e2 ? void 0 : e2.zv) && void 0 !== i ? i : null), this.$i().Wc(e2 && { jc: e2.jc, Av: e2.Av });
    }
    cv(t) {
      null !== this.Ep && (this.Xp(), this.Qp(t));
    }
    Uf(t) {
      null !== this.Ep && this.tm(this.Vp, t);
    }
    Wf(t) {
      this.Uf(t);
    }
    lv(t) {
      this.Xp(), this.im(t), this.Kp(t.localX, t.localY, t);
    }
    uv(t) {
      null !== this.Ep && (this.Xp(), this.Bp = false, this.nm(t));
    }
    _v(t) {
      null !== this.Ep && this.Qp(t);
    }
    Pv(t) {
      if (this.Bp = true, null === this.Ap) {
        const i = { x: t.localX, y: t.localY };
        this.sm(i, i, t);
      }
    }
    Tv(t) {
      null !== this.Ep && (this.Xp(), this.Ep.$t().Wc(null), this.rm());
    }
    hm() {
      return this.Dp;
    }
    lm() {
      return this.Vp;
    }
    Mv() {
      this.Op = 1, this.$i().Un();
    }
    xv(t, i) {
      if (!this.Jd.W().handleScale.pinch) return;
      const n = 5 * (i - this.Op);
      this.Op = i, this.$i().Jc(t.nt, n);
    }
    vv(t) {
      this.Bp = false, this.Ip = null !== this.Ap, this.Gp();
      const i = this.$i().Yc();
      null !== this.Ap && i.yt() && (this.zp = { x: i.Yt(), y: i.Zt() }, this.Ap = { x: t.localX, y: t.localY });
    }
    rv(t) {
      if (null === this.Ep) return;
      const i = t.localX, n = t.localY;
      if (null === this.Ap) this.im(t);
      else {
        this.Ip = false;
        const s = b(this.zp), e2 = s.x + (i - this.Ap.x), r2 = s.y + (n - this.Ap.y);
        this.Kp(e2, r2, t);
      }
    }
    ov(t) {
      0 === this.Hv().W().trackingMode.exitMode && (this.Ip = true), this.am(), this.nm(t);
    }
    br(t, i) {
      const n = this.Ep;
      return null === n ? null : (function(t2, i2, n2) {
        const s = t2.$o(), e2 = (function(t3, i3, n3) {
          var s2, e3;
          let r2, h2;
          for (const o2 of t3) {
            const t4 = null !== (e3 = null === (s2 = o2.fa) || void 0 === s2 ? void 0 : s2.call(o2, i3, n3)) && void 0 !== e3 ? e3 : [];
            for (const i4 of t4) l2 = i4.zOrder, (!(a2 = null == r2 ? void 0 : r2.zOrder) || "top" === l2 && "top" !== a2 || "normal" === l2 && "bottom" === a2) && (r2 = i4, h2 = o2);
          }
          var l2, a2;
          return r2 && h2 ? { Iv: r2, jc: h2 } : null;
        })(s, i2, n2);
        if ("top" === (null == e2 ? void 0 : e2.Iv.zOrder)) return xs(e2);
        for (const r2 of s) {
          if (e2 && e2.jc === r2 && "bottom" !== e2.Iv.zOrder && !e2.Iv.isBackground) return xs(e2);
          const s2 = Ss(r2.Pn(t2), i2, n2);
          if (null !== s2) return { jc: r2, Ov: s2.Ov, Av: s2.Av };
          if (e2 && e2.jc === r2 && "bottom" !== e2.Iv.zOrder && e2.Iv.isBackground) return xs(e2);
        }
        return (null == e2 ? void 0 : e2.Iv) ? xs(e2) : null;
      })(n, t, i);
    }
    om(i, n) {
      b("left" === n ? this.yp : this.Cp).up(size({ width: i, height: this.Lv.height }));
    }
    _m() {
      return this.Lv;
    }
    up(t) {
      equalSizes(this.Lv, t) || (this.Lv = t, this.Wv = true, this.Kv.resizeCanvasElement(t), this.Gv.resizeCanvasElement(t), this.Wv = false, this.Fp.style.width = t.width + "px", this.Fp.style.height = t.height + "px");
    }
    um() {
      const t = b(this.Ep);
      t.T_(t.P_()), t.T_(t.R_());
      for (const i of t.Oa()) if (t.dr(i)) {
        const n = i.Dt();
        null !== n && t.T_(n), i.Vn();
      }
    }
    Mp() {
      return this.Kv.bitmapSize;
    }
    xp(t, i, n) {
      const s = this.Mp();
      s.width > 0 && s.height > 0 && t.drawImage(this.Kv.canvasElement, i, n);
    }
    fp(t) {
      if (0 === t) return;
      if (null === this.Ep) return;
      if (t > 1 && this.um(), null !== this.yp && this.yp.fp(t), null !== this.Cp && this.Cp.fp(t), 1 !== t) {
        this.Kv.applySuggestedBitmapSize();
        const t2 = tryCreateCanvasRenderingTarget2D(this.Kv);
        null !== t2 && (t2.useBitmapCoordinateSpace(((t3) => {
          this.pp(t3);
        })), this.Ep && (this.dm(t2, Ts), this.fm(t2), this.vm(t2), this.dm(t2, Ps), this.dm(t2, Rs)));
      }
      this.Gv.applySuggestedBitmapSize();
      const i = tryCreateCanvasRenderingTarget2D(this.Gv);
      null !== i && (i.useBitmapCoordinateSpace((({ context: t2, bitmapSize: i2 }) => {
        t2.clearRect(0, 0, i2.width, i2.height);
      })), this.pm(i), this.dm(i, Ds));
    }
    bm() {
      return this.yp;
    }
    wm() {
      return this.Cp;
    }
    mp(t, i) {
      this.dm(t, i);
    }
    Np() {
      null !== this.Ep && this.Ep.F_().p(this), this.Ep = null;
    }
    Qp(t) {
      this.tm(this.Dp, t);
    }
    tm(t, i) {
      const n = i.localX, s = i.localY;
      t.M() && t.m(this.$i().St().Eu(n), { x: n, y: s }, i);
    }
    pp({ context: t, bitmapSize: i }) {
      const { width: n, height: s } = i, e2 = this.$i(), r2 = e2.q(), h2 = e2.md();
      r2 === h2 ? G(t, 0, 0, n, s, h2) : tt(t, 0, 0, n, s, r2, h2);
    }
    fm(t) {
      const i = b(this.Ep).W_().Uh().gt();
      null !== i && i.X(t, false);
    }
    vm(t) {
      const i = this.$i().qc();
      this.gm(t, Ps, cs, i), this.gm(t, Ps, ds, i);
    }
    pm(t) {
      this.gm(t, Ps, ds, this.$i().Yc());
    }
    dm(t, i) {
      const n = b(this.Ep).$o();
      for (const s of n) this.gm(t, i, cs, s);
      for (const s of n) this.gm(t, i, ds, s);
    }
    gm(t, i, n, s) {
      const e2 = b(this.Ep), r2 = e2.$t().Fc(), h2 = null !== r2 && r2.jc === s, l2 = null !== r2 && h2 && void 0 !== r2.Av ? r2.Av.gr : void 0;
      fs(i, ((i2) => n(i2, t, h2, l2)), s, e2);
    }
    Yp() {
      if (null === this.Ep) return;
      const t = this.Jd, i = this.Ep.P_().W().visible, n = this.Ep.R_().W().visible;
      i || null === this.yp || (this.Wp.removeChild(this.yp.hp()), this.yp.S(), this.yp = null), n || null === this.Cp || (this.jp.removeChild(this.Cp.hp()), this.Cp.S(), this.Cp = null);
      const s = t.$t()._d();
      i && null === this.yp && (this.yp = new Cs(this, t.W(), s, "left"), this.Wp.appendChild(this.yp.hp())), n && null === this.Cp && (this.Cp = new Cs(this, t.W(), s, "right"), this.jp.appendChild(this.Cp.hp()));
    }
    Mm(t) {
      return t.Rv && this.Bp || null !== this.Ap;
    }
    xm(t) {
      return Math.max(0, Math.min(t, this.Lv.width - 1));
    }
    Sm(t) {
      return Math.max(0, Math.min(t, this.Lv.height - 1));
    }
    Kp(t, i, n) {
      this.$i().hd(this.xm(t), this.Sm(i), n, b(this.Ep));
    }
    rm() {
      this.$i().ad();
    }
    am() {
      this.Ip && (this.Ap = null, this.rm());
    }
    sm(t, i, n) {
      this.Ap = t, this.Ip = false, this.Kp(i.x, i.y, n);
      const s = this.$i().Yc();
      this.zp = { x: s.Yt(), y: s.Zt() };
    }
    $i() {
      return this.Jd.$t();
    }
    nm(t) {
      if (!this.Rp) return;
      const i = this.$i(), n = this.dp();
      if (i.I_(n, n.vn()), this.Pp = null, this.Rp = false, i.sd(), null !== this.Lp) {
        const t2 = performance.now(), n2 = i.St();
        this.Lp.Dr(n2.ju(), t2), this.Lp.Ju(t2) || i.Zn(this.Lp);
      }
    }
    Xp() {
      this.Ap = null;
    }
    Gp() {
      if (!this.Ep) return;
      if (this.$i().Un(), document.activeElement !== document.body && document.activeElement !== document.documentElement) b(document.activeElement).blur();
      else {
        const t = document.getSelection();
        null !== t && t.removeAllRanges();
      }
      !this.Ep.vn().Ni() && this.$i().St().Ni();
    }
    im(t) {
      if (null === this.Ep) return;
      const i = this.$i(), n = i.St();
      if (n.Ni()) return;
      const s = this.Jd.W(), e2 = s.handleScroll, r2 = s.kineticScroll;
      if ((!e2.pressedMouseMove || t.Rv) && (!e2.horzTouchDrag && !e2.vertTouchDrag || !t.Rv)) return;
      const h2 = this.Ep.vn(), l2 = performance.now();
      if (null !== this.Pp || this.Mm(t) || (this.Pp = { x: t.clientX, y: t.clientY, Vd: l2, km: t.localX, ym: t.localY }), null !== this.Pp && !this.Rp && (this.Pp.x !== t.clientX || this.Pp.y !== t.clientY)) {
        if (t.Rv && r2.touch || !t.Rv && r2.mouse) {
          const t2 = n.he();
          this.Lp = new as(0.2 / t2, 7 / t2, 0.997, 15 / t2), this.Lp.qd(n.ju(), this.Pp.Vd);
        } else this.Lp = null;
        h2.Ni() || i.B_(this.Ep, h2, t.localY), i.td(t.localX), this.Rp = true;
      }
      this.Rp && (h2.Ni() || i.A_(this.Ep, h2, t.localY), i.nd(t.localX), null !== this.Lp && this.Lp.qd(n.ju(), l2));
    }
  };
  var Os = class {
    constructor(i, n, s, e2, r2) {
      this.ft = true, this.Lv = size({ width: 0, height: 0 }), this.jv = () => this.fp(3), this.Uv = "left" === i, this.Vc = s._d, this.cn = n, this.Cm = e2, this.Tm = r2, this.Xv = document.createElement("div"), this.Xv.style.width = "25px", this.Xv.style.height = "100%", this.Xv.style.overflow = "hidden", this.Kv = _s(this.Xv, size({ width: 16, height: 16 })), this.Kv.subscribeSuggestedBitmapSizeChanged(this.jv);
    }
    S() {
      this.Kv.unsubscribeSuggestedBitmapSizeChanged(this.jv), us(this.Kv.canvasElement), this.Kv.dispose();
    }
    hp() {
      return this.Xv;
    }
    _m() {
      return this.Lv;
    }
    up(t) {
      equalSizes(this.Lv, t) || (this.Lv = t, this.Kv.resizeCanvasElement(t), this.Xv.style.width = `${t.width}px`, this.Xv.style.height = `${t.height}px`, this.ft = true);
    }
    fp(t) {
      if (t < 3 && !this.ft) return;
      if (0 === this.Lv.width || 0 === this.Lv.height) return;
      this.ft = false, this.Kv.applySuggestedBitmapSize();
      const i = tryCreateCanvasRenderingTarget2D(this.Kv);
      null !== i && i.useBitmapCoordinateSpace(((t2) => {
        this.pp(t2), this.Ae(t2);
      }));
    }
    Mp() {
      return this.Kv.bitmapSize;
    }
    xp(t, i, n) {
      const s = this.Mp();
      s.width > 0 && s.height > 0 && t.drawImage(this.Kv.canvasElement, i, n);
    }
    Ae({ context: t, bitmapSize: i, horizontalPixelRatio: n, verticalPixelRatio: s }) {
      if (!this.Cm()) return;
      t.fillStyle = this.cn.timeScale.borderColor;
      const e2 = Math.floor(this.Vc.W().C * n), r2 = Math.floor(this.Vc.W().C * s), h2 = this.Uv ? i.width - e2 : 0;
      t.fillRect(h2, 0, e2, r2);
    }
    pp({ context: t, bitmapSize: i }) {
      G(t, 0, 0, i.width, i.height, this.Tm());
    }
  };
  function Bs(t) {
    return (i) => {
      var n, s;
      return null !== (s = null === (n = i.da) || void 0 === n ? void 0 : n.call(i, t)) && void 0 !== s ? s : [];
    };
  }
  var As = Bs("normal");
  var Is = Bs("top");
  var zs = Bs("bottom");
  var Ls = class {
    constructor(i, n) {
      this.Pm = null, this.Rm = null, this.k = null, this.Dm = false, this.Lv = size({ width: 0, height: 0 }), this.Vm = new D(), this.Nv = new ni(5), this.Wv = false, this.jv = () => {
        this.Wv || this.Jd.$t().$h();
      }, this.$v = () => {
        this.Wv || this.Jd.$t().$h();
      }, this.Jd = i, this.U_ = n, this.cn = i.W().layout, this.Zd = document.createElement("tr"), this.Om = document.createElement("td"), this.Om.style.padding = "0", this.Bm = document.createElement("td"), this.Bm.style.padding = "0", this.Xv = document.createElement("td"), this.Xv.style.height = "25px", this.Xv.style.padding = "0", this.Am = document.createElement("div"), this.Am.style.width = "100%", this.Am.style.height = "100%", this.Am.style.position = "relative", this.Am.style.overflow = "hidden", this.Xv.appendChild(this.Am), this.Kv = _s(this.Am, size({ width: 16, height: 16 })), this.Kv.subscribeSuggestedBitmapSizeChanged(this.jv);
      const s = this.Kv.canvasElement;
      s.style.position = "absolute", s.style.zIndex = "1", s.style.left = "0", s.style.top = "0", this.Gv = _s(this.Am, size({ width: 16, height: 16 })), this.Gv.subscribeSuggestedBitmapSizeChanged(this.$v);
      const e2 = this.Gv.canvasElement;
      e2.style.position = "absolute", e2.style.zIndex = "2", e2.style.left = "0", e2.style.top = "0", this.Zd.appendChild(this.Om), this.Zd.appendChild(this.Xv), this.Zd.appendChild(this.Bm), this.Im(), this.Jd.$t().w_().l(this.Im.bind(this), this), this.rp = new ps(this.Gv.canvasElement, this, { sv: () => true, ev: () => !this.Jd.W().handleScroll.horzTouchDrag });
    }
    S() {
      this.rp.S(), null !== this.Pm && this.Pm.S(), null !== this.Rm && this.Rm.S(), this.Gv.unsubscribeSuggestedBitmapSizeChanged(this.$v), us(this.Gv.canvasElement), this.Gv.dispose(), this.Kv.unsubscribeSuggestedBitmapSizeChanged(this.jv), us(this.Kv.canvasElement), this.Kv.dispose();
    }
    hp() {
      return this.Zd;
    }
    zm() {
      return this.Pm;
    }
    Lm() {
      return this.Rm;
    }
    mv(t) {
      if (this.Dm) return;
      this.Dm = true;
      const i = this.Jd.$t();
      !i.St().Ni() && this.Jd.W().handleScale.axisPressedMouseMove.time && i.Gc(t.localX);
    }
    vv(t) {
      this.mv(t);
    }
    bv() {
      const t = this.Jd.$t();
      !t.St().Ni() && this.Dm && (this.Dm = false, this.Jd.W().handleScale.axisPressedMouseMove.time && t.rd());
    }
    lv(t) {
      const i = this.Jd.$t();
      !i.St().Ni() && this.Jd.W().handleScale.axisPressedMouseMove.time && i.ed(t.localX);
    }
    rv(t) {
      this.lv(t);
    }
    uv() {
      this.Dm = false;
      const t = this.Jd.$t();
      t.St().Ni() && !this.Jd.W().handleScale.axisPressedMouseMove.time || t.rd();
    }
    ov() {
      this.uv();
    }
    Uf() {
      this.Jd.W().handleScale.axisDoubleClickReset.time && this.Jd.$t().Kn();
    }
    Wf() {
      this.Uf();
    }
    Jf() {
      this.Jd.$t().W().handleScale.axisPressedMouseMove.time && this.Sp(1);
    }
    Tv() {
      this.Sp(0);
    }
    _m() {
      return this.Lv;
    }
    Em() {
      return this.Vm;
    }
    Nm(i, s, e2) {
      equalSizes(this.Lv, i) || (this.Lv = i, this.Wv = true, this.Kv.resizeCanvasElement(i), this.Gv.resizeCanvasElement(i), this.Wv = false, this.Xv.style.width = `${i.width}px`, this.Xv.style.height = `${i.height}px`, this.Vm.m(i)), null !== this.Pm && this.Pm.up(size({ width: s, height: i.height })), null !== this.Rm && this.Rm.up(size({ width: e2, height: i.height }));
    }
    Fm() {
      const t = this.Wm();
      return Math.ceil(t.C + t.T + t.P + t.L + t.B + t.jm);
    }
    bt() {
      this.Jd.$t().St().ja();
    }
    Mp() {
      return this.Kv.bitmapSize;
    }
    xp(t, i, n) {
      const s = this.Mp();
      s.width > 0 && s.height > 0 && t.drawImage(this.Kv.canvasElement, i, n);
    }
    fp(t) {
      if (0 === t) return;
      if (1 !== t) {
        this.Kv.applySuggestedBitmapSize();
        const i2 = tryCreateCanvasRenderingTarget2D(this.Kv);
        null !== i2 && (i2.useBitmapCoordinateSpace(((t2) => {
          this.pp(t2), this.Ae(t2), this.Hm(i2, zs);
        })), this.bp(i2), this.Hm(i2, As)), null !== this.Pm && this.Pm.fp(t), null !== this.Rm && this.Rm.fp(t);
      }
      this.Gv.applySuggestedBitmapSize();
      const i = tryCreateCanvasRenderingTarget2D(this.Gv);
      null !== i && (i.useBitmapCoordinateSpace((({ context: t2, bitmapSize: i2 }) => {
        t2.clearRect(0, 0, i2.width, i2.height);
      })), this.$m([...this.Jd.$t().wt(), this.Jd.$t().Yc()], i), this.Hm(i, Is));
    }
    Hm(t, i) {
      const n = this.Jd.$t().wt();
      for (const s of n) fs(i, ((i2) => cs(i2, t, false, void 0)), s, void 0);
      for (const s of n) fs(i, ((i2) => ds(i2, t, false, void 0)), s, void 0);
    }
    pp({ context: t, bitmapSize: i }) {
      G(t, 0, 0, i.width, i.height, this.Jd.$t().md());
    }
    Ae({ context: t, bitmapSize: i, verticalPixelRatio: n }) {
      if (this.Jd.W().timeScale.borderVisible) {
        t.fillStyle = this.Um();
        const s = Math.max(1, Math.floor(this.Wm().C * n));
        t.fillRect(0, 0, i.width, s);
      }
    }
    bp(t) {
      const i = this.Jd.$t().St(), n = i.ja();
      if (!n || 0 === n.length) return;
      const s = this.U_.maxTickMarkWeight(n), e2 = this.Wm(), r2 = i.W();
      r2.borderVisible && r2.ticksVisible && t.useBitmapCoordinateSpace((({ context: t2, horizontalPixelRatio: i2, verticalPixelRatio: s2 }) => {
        t2.strokeStyle = this.Um(), t2.fillStyle = this.Um();
        const r3 = Math.max(1, Math.floor(i2)), h2 = Math.floor(0.5 * i2);
        t2.beginPath();
        const l2 = Math.round(e2.T * s2);
        for (let s3 = n.length; s3--; ) {
          const e3 = Math.round(n[s3].coord * i2);
          t2.rect(e3 - h2, 0, r3, l2);
        }
        t2.fill();
      })), t.useMediaCoordinateSpace((({ context: t2 }) => {
        const i2 = e2.C + e2.T + e2.L + e2.P / 2;
        t2.textAlign = "center", t2.textBaseline = "middle", t2.fillStyle = this.$(), t2.font = this.op();
        for (const e3 of n) if (e3.weight < s) {
          const n2 = e3.needAlignCoordinate ? this.qm(t2, e3.coord, e3.label) : e3.coord;
          t2.fillText(e3.label, n2, i2);
        }
        this.Jd.W().timeScale.allowBoldLabels && (t2.font = this.Ym());
        for (const e3 of n) if (e3.weight >= s) {
          const n2 = e3.needAlignCoordinate ? this.qm(t2, e3.coord, e3.label) : e3.coord;
          t2.fillText(e3.label, n2, i2);
        }
      }));
    }
    qm(t, i, n) {
      const s = this.Nv.xi(t, n), e2 = s / 2, r2 = Math.floor(i - e2) + 0.5;
      return r2 < 0 ? i += Math.abs(0 - r2) : r2 + s > this.Lv.width && (i -= Math.abs(this.Lv.width - (r2 + s))), i;
    }
    $m(t, i) {
      const n = this.Wm();
      for (const s of t) for (const t2 of s.Qi()) t2.gt().X(i, n);
    }
    Um() {
      return this.Jd.W().timeScale.borderColor;
    }
    $() {
      return this.cn.textColor;
    }
    j() {
      return this.cn.fontSize;
    }
    op() {
      return F(this.j(), this.cn.fontFamily);
    }
    Ym() {
      return F(this.j(), this.cn.fontFamily, "bold");
    }
    Wm() {
      null === this.k && (this.k = { C: 1, N: NaN, L: NaN, B: NaN, ji: NaN, T: 5, P: NaN, R: "", Wi: new ni(), jm: 0 });
      const t = this.k, i = this.op();
      if (t.R !== i) {
        const n = this.j();
        t.P = n, t.R = i, t.L = 3 * n / 12, t.B = 3 * n / 12, t.ji = 9 * n / 12, t.N = 0, t.jm = 4 * n / 12, t.Wi.ir();
      }
      return this.k;
    }
    Sp(t) {
      this.Xv.style.cursor = 1 === t ? "ew-resize" : "default";
    }
    Im() {
      const t = this.Jd.$t(), i = t.W();
      i.leftPriceScale.visible || null === this.Pm || (this.Om.removeChild(this.Pm.hp()), this.Pm.S(), this.Pm = null), i.rightPriceScale.visible || null === this.Rm || (this.Bm.removeChild(this.Rm.hp()), this.Rm.S(), this.Rm = null);
      const n = { _d: this.Jd.$t()._d() }, s = () => i.leftPriceScale.borderVisible && t.St().W().borderVisible, e2 = () => t.md();
      i.leftPriceScale.visible && null === this.Pm && (this.Pm = new Os("left", i, n, s, e2), this.Om.appendChild(this.Pm.hp())), i.rightPriceScale.visible && null === this.Rm && (this.Rm = new Os("right", i, n, s, e2), this.Bm.appendChild(this.Rm.hp()));
    }
  };
  var Es = !!ns && !!navigator.userAgentData && navigator.userAgentData.brands.some(((t) => t.brand.includes("Chromium"))) && !!ns && ((null === (Ns = null === navigator || void 0 === navigator ? void 0 : navigator.userAgentData) || void 0 === Ns ? void 0 : Ns.platform) ? "Windows" === navigator.userAgentData.platform : navigator.userAgent.toLowerCase().indexOf("win") >= 0);
  var Ns;
  var Fs = class {
    constructor(t, i, n) {
      var s;
      this.Zm = [], this.Xm = 0, this.ro = 0, this.o_ = 0, this.Km = 0, this.Gm = 0, this.Jm = null, this.Qm = false, this.Dp = new D(), this.Vp = new D(), this.Pc = new D(), this.tb = null, this.ib = null, this.Gd = t, this.cn = i, this.U_ = n, this.Zd = document.createElement("div"), this.Zd.classList.add("tv-lightweight-charts"), this.Zd.style.overflow = "hidden", this.Zd.style.direction = "ltr", this.Zd.style.width = "100%", this.Zd.style.height = "100%", (s = this.Zd).style.userSelect = "none", s.style.webkitUserSelect = "none", s.style.msUserSelect = "none", s.style.MozUserSelect = "none", s.style.webkitTapHighlightColor = "transparent", this.nb = document.createElement("table"), this.nb.setAttribute("cellspacing", "0"), this.Zd.appendChild(this.nb), this.sb = this.eb.bind(this), Ws(this.cn) && this.rb(true), this.$i = new Ln(this.Dc.bind(this), this.cn, n), this.$t().Zc().l(this.hb.bind(this), this), this.lb = new Ls(this, this.U_), this.nb.appendChild(this.lb.hp());
      const e2 = i.autoSize && this.ab();
      let r2 = this.cn.width, h2 = this.cn.height;
      if (e2 || 0 === r2 || 0 === h2) {
        const i2 = t.getBoundingClientRect();
        r2 = r2 || i2.width, h2 = h2 || i2.height;
      }
      this.ob(r2, h2), this._b(), t.appendChild(this.Zd), this.ub(), this.$i.St().sc().l(this.$i.Xl.bind(this.$i), this), this.$i.w_().l(this.$i.Xl.bind(this.$i), this);
    }
    $t() {
      return this.$i;
    }
    W() {
      return this.cn;
    }
    qp() {
      return this.Zm;
    }
    cb() {
      return this.lb;
    }
    S() {
      this.rb(false), 0 !== this.Xm && window.cancelAnimationFrame(this.Xm), this.$i.Zc().p(this), this.$i.St().sc().p(this), this.$i.w_().p(this), this.$i.S();
      for (const t of this.Zm) this.nb.removeChild(t.hp()), t.hm().p(this), t.lm().p(this), t.S();
      this.Zm = [], b(this.lb).S(), null !== this.Zd.parentElement && this.Zd.parentElement.removeChild(this.Zd), this.Pc.S(), this.Dp.S(), this.Vp.S(), this.fb();
    }
    ob(i, n, s = false) {
      if (this.ro === n && this.o_ === i) return;
      const e2 = (function(i2) {
        const n2 = Math.floor(i2.width), s2 = Math.floor(i2.height);
        return size({ width: n2 - n2 % 2, height: s2 - s2 % 2 });
      })(size({ width: i, height: n }));
      this.ro = e2.height, this.o_ = e2.width;
      const r2 = this.ro + "px", h2 = this.o_ + "px";
      b(this.Zd).style.height = r2, b(this.Zd).style.width = h2, this.nb.style.height = r2, this.nb.style.width = h2, s ? this.pb(ut.es(), performance.now()) : this.$i.Xl();
    }
    fp(t) {
      void 0 === t && (t = ut.es());
      for (let i = 0; i < this.Zm.length; i++) this.Zm[i].fp(t.Hn(i).Fn);
      this.cn.timeScale.visible && this.lb.fp(t.jn());
    }
    Hh(t) {
      const i = Ws(this.cn);
      this.$i.Hh(t);
      const n = Ws(this.cn);
      n !== i && this.rb(n), this.ub(), this.mb(t);
    }
    hm() {
      return this.Dp;
    }
    lm() {
      return this.Vp;
    }
    Zc() {
      return this.Pc;
    }
    bb() {
      null !== this.Jm && (this.pb(this.Jm, performance.now()), this.Jm = null);
      const t = this.wb(null), i = document.createElement("canvas");
      i.width = t.width, i.height = t.height;
      const n = b(i.getContext("2d"));
      return this.wb(n), i;
    }
    gb(t) {
      if ("left" === t && !this.Mb()) return 0;
      if ("right" === t && !this.xb()) return 0;
      if (0 === this.Zm.length) return 0;
      return b("left" === t ? this.Zm[0].bm() : this.Zm[0].wm()).cp();
    }
    Sb() {
      return this.cn.autoSize && null !== this.tb;
    }
    kb() {
      return this.Zd;
    }
    Jp(t) {
      this.ib = t, this.ib ? this.kb().style.setProperty("cursor", t) : this.kb().style.removeProperty("cursor");
    }
    yb() {
      return this.ib;
    }
    Cb() {
      return m(this.Zm[0])._m();
    }
    mb(t) {
      (void 0 !== t.autoSize || !this.tb || void 0 === t.width && void 0 === t.height) && (t.autoSize && !this.tb && this.ab(), false === t.autoSize && null !== this.tb && this.fb(), t.autoSize || void 0 === t.width && void 0 === t.height || this.ob(t.width || this.o_, t.height || this.ro));
    }
    wb(i) {
      let n = 0, s = 0;
      const e2 = this.Zm[0], r2 = (t, n2) => {
        let s2 = 0;
        for (let e3 = 0; e3 < this.Zm.length; e3++) {
          const r3 = this.Zm[e3], h3 = b("left" === t ? r3.bm() : r3.wm()), l2 = h3.Mp();
          null !== i && h3.xp(i, n2, s2), s2 += l2.height;
        }
      };
      if (this.Mb()) {
        r2("left", 0);
        n += b(e2.bm()).Mp().width;
      }
      for (let t = 0; t < this.Zm.length; t++) {
        const e3 = this.Zm[t], r3 = e3.Mp();
        null !== i && e3.xp(i, n, s), s += r3.height;
      }
      if (n += e2.Mp().width, this.xb()) {
        r2("right", n);
        n += b(e2.wm()).Mp().width;
      }
      const h2 = (t, n2, s2) => {
        b("left" === t ? this.lb.zm() : this.lb.Lm()).xp(b(i), n2, s2);
      };
      if (this.cn.timeScale.visible) {
        const t = this.lb.Mp();
        if (null !== i) {
          let n2 = 0;
          this.Mb() && (h2("left", n2, s), n2 = b(e2.bm()).Mp().width), this.lb.xp(i, n2, s), n2 += t.width, this.xb() && h2("right", n2, s);
        }
        s += t.height;
      }
      return size({ width: n, height: s });
    }
    Tb() {
      let i = 0, n = 0, s = 0;
      for (const t of this.Zm) this.Mb() && (n = Math.max(n, b(t.bm()).ap(), this.cn.leftPriceScale.minimumWidth)), this.xb() && (s = Math.max(s, b(t.wm()).ap(), this.cn.rightPriceScale.minimumWidth)), i += t.g_();
      n = rs(n), s = rs(s);
      const e2 = this.o_, r2 = this.ro, h2 = Math.max(e2 - n - s, 0), l2 = this.cn.timeScale.visible;
      let a2 = l2 ? Math.max(this.lb.Fm(), this.cn.timeScale.minimumHeight) : 0;
      var o2;
      a2 = (o2 = a2) + o2 % 2;
      const _2 = 0 + a2, u2 = r2 < _2 ? 0 : r2 - _2, c2 = u2 / i;
      let d2 = 0;
      for (let i2 = 0; i2 < this.Zm.length; ++i2) {
        const e3 = this.Zm[i2];
        e3.Up(this.$i.Uc()[i2]);
        let r3 = 0, l3 = 0;
        l3 = i2 === this.Zm.length - 1 ? u2 - d2 : Math.round(e3.g_() * c2), r3 = Math.max(l3, 2), d2 += r3, e3.up(size({ width: h2, height: r3 })), this.Mb() && e3.om(n, "left"), this.xb() && e3.om(s, "right"), e3.dp() && this.$i.Xc(e3.dp(), r3);
      }
      this.lb.Nm(size({ width: l2 ? h2 : 0, height: a2 }), l2 ? n : 0, l2 ? s : 0), this.$i.x_(h2), this.Km !== n && (this.Km = n), this.Gm !== s && (this.Gm = s);
    }
    rb(t) {
      t ? this.Zd.addEventListener("wheel", this.sb, { passive: false }) : this.Zd.removeEventListener("wheel", this.sb);
    }
    Pb(t) {
      switch (t.deltaMode) {
        case t.DOM_DELTA_PAGE:
          return 120;
        case t.DOM_DELTA_LINE:
          return 32;
      }
      return Es ? 1 / window.devicePixelRatio : 1;
    }
    eb(t) {
      if (!(0 !== t.deltaX && this.cn.handleScroll.mouseWheel || 0 !== t.deltaY && this.cn.handleScale.mouseWheel)) return;
      const i = this.Pb(t), n = i * t.deltaX / 100, s = -i * t.deltaY / 100;
      if (t.cancelable && t.preventDefault(), 0 !== s && this.cn.handleScale.mouseWheel) {
        const i2 = Math.sign(s) * Math.min(1, Math.abs(s)), n2 = t.clientX - this.Zd.getBoundingClientRect().left;
        this.$t().Jc(n2, i2);
      }
      0 !== n && this.cn.handleScroll.mouseWheel && this.$t().Qc(-80 * n);
    }
    pb(t, i) {
      var n;
      const s = t.jn();
      3 === s && this.Rb(), 3 !== s && 2 !== s || (this.Db(t), this.Vb(t, i), this.lb.bt(), this.Zm.forEach(((t2) => {
        t2.Zp();
      })), 3 === (null === (n = this.Jm) || void 0 === n ? void 0 : n.jn()) && (this.Jm.ts(t), this.Rb(), this.Db(this.Jm), this.Vb(this.Jm, i), t = this.Jm, this.Jm = null)), this.fp(t);
    }
    Vb(t, i) {
      for (const n of t.Qn()) this.ns(n, i);
    }
    Db(t) {
      const i = this.$i.Uc();
      for (let n = 0; n < i.length; n++) t.Hn(n).Wn && i[n].E_();
    }
    ns(t, i) {
      const n = this.$i.St();
      switch (t.qn) {
        case 0:
          n.rc();
          break;
        case 1:
          n.hc(t.Vt);
          break;
        case 2:
          n.Gn(t.Vt);
          break;
        case 3:
          n.Jn(t.Vt);
          break;
        case 4:
          n.Uu();
          break;
        case 5:
          t.Vt.Ju(i) || n.Jn(t.Vt.Qu(i));
      }
    }
    Dc(t) {
      null !== this.Jm ? this.Jm.ts(t) : this.Jm = t, this.Qm || (this.Qm = true, this.Xm = window.requestAnimationFrame(((t2) => {
        if (this.Qm = false, this.Xm = 0, null !== this.Jm) {
          const i = this.Jm;
          this.Jm = null, this.pb(i, t2);
          for (const n of i.Qn()) if (5 === n.qn && !n.Vt.Ju(t2)) {
            this.$t().Zn(n.Vt);
            break;
          }
        }
      })));
    }
    Rb() {
      this._b();
    }
    _b() {
      const t = this.$i.Uc(), i = t.length, n = this.Zm.length;
      for (let t2 = i; t2 < n; t2++) {
        const t3 = m(this.Zm.pop());
        this.nb.removeChild(t3.hp()), t3.hm().p(this), t3.lm().p(this), t3.S();
      }
      for (let s = n; s < i; s++) {
        const i2 = new Vs(this, t[s]);
        i2.hm().l(this.Ob.bind(this), this), i2.lm().l(this.Bb.bind(this), this), this.Zm.push(i2), this.nb.insertBefore(i2.hp(), this.lb.hp());
      }
      for (let n2 = 0; n2 < i; n2++) {
        const i2 = t[n2], s = this.Zm[n2];
        s.dp() !== i2 ? s.Up(i2) : s.$p();
      }
      this.ub(), this.Tb();
    }
    Ab(t, i, n) {
      var s;
      const e2 = /* @__PURE__ */ new Map();
      if (null !== t) {
        this.$i.wt().forEach(((i2) => {
          const n2 = i2.In().hl(t);
          null !== n2 && e2.set(i2, n2);
        }));
      }
      let r2;
      if (null !== t) {
        const i2 = null === (s = this.$i.St().Ui(t)) || void 0 === s ? void 0 : s.originalTime;
        void 0 !== i2 && (r2 = i2);
      }
      const h2 = this.$t().Fc(), l2 = null !== h2 && h2.jc instanceof Gi ? h2.jc : void 0, a2 = null !== h2 && void 0 !== h2.Av ? h2.Av.wr : void 0;
      return { Ib: r2, se: null != t ? t : void 0, zb: null != i ? i : void 0, Lb: l2, Eb: e2, Nb: a2, Fb: null != n ? n : void 0 };
    }
    Ob(t, i, n) {
      this.Dp.m((() => this.Ab(t, i, n)));
    }
    Bb(t, i, n) {
      this.Vp.m((() => this.Ab(t, i, n)));
    }
    hb(t, i, n) {
      this.Pc.m((() => this.Ab(t, i, n)));
    }
    ub() {
      const t = this.cn.timeScale.visible ? "" : "none";
      this.lb.hp().style.display = t;
    }
    Mb() {
      return this.Zm[0].dp().P_().W().visible;
    }
    xb() {
      return this.Zm[0].dp().R_().W().visible;
    }
    ab() {
      return "ResizeObserver" in window && (this.tb = new ResizeObserver(((t) => {
        const i = t.find(((t2) => t2.target === this.Gd));
        i && this.ob(i.contentRect.width, i.contentRect.height);
      })), this.tb.observe(this.Gd, { box: "border-box" }), true);
    }
    fb() {
      null !== this.tb && this.tb.disconnect(), this.tb = null;
    }
  };
  function Ws(t) {
    return Boolean(t.handleScroll.mouseWheel || t.handleScale.mouseWheel);
  }
  function js(t) {
    return (function(t2) {
      return void 0 !== t2.open;
    })(t) || (function(t2) {
      return void 0 !== t2.value;
    })(t);
  }
  function Hs(t, i) {
    var n = {};
    for (var s in t) Object.prototype.hasOwnProperty.call(t, s) && i.indexOf(s) < 0 && (n[s] = t[s]);
    if (null != t && "function" == typeof Object.getOwnPropertySymbols) {
      var e2 = 0;
      for (s = Object.getOwnPropertySymbols(t); e2 < s.length; e2++) i.indexOf(s[e2]) < 0 && Object.prototype.propertyIsEnumerable.call(t, s[e2]) && (n[s[e2]] = t[s[e2]]);
    }
    return n;
  }
  function $s(t, i, n, s) {
    const e2 = n.value, r2 = { se: i, ot: t, Vt: [e2, e2, e2, e2], Ib: s };
    return void 0 !== n.color && (r2.V = n.color), r2;
  }
  function Us(t, i, n, s) {
    const e2 = n.value, r2 = { se: i, ot: t, Vt: [e2, e2, e2, e2], Ib: s };
    return void 0 !== n.lineColor && (r2.lt = n.lineColor), void 0 !== n.topColor && (r2.Ts = n.topColor), void 0 !== n.bottomColor && (r2.Ps = n.bottomColor), r2;
  }
  function qs(t, i, n, s) {
    const e2 = n.value, r2 = { se: i, ot: t, Vt: [e2, e2, e2, e2], Ib: s };
    return void 0 !== n.topLineColor && (r2.Pe = n.topLineColor), void 0 !== n.bottomLineColor && (r2.Re = n.bottomLineColor), void 0 !== n.topFillColor1 && (r2.Se = n.topFillColor1), void 0 !== n.topFillColor2 && (r2.ke = n.topFillColor2), void 0 !== n.bottomFillColor1 && (r2.ye = n.bottomFillColor1), void 0 !== n.bottomFillColor2 && (r2.Ce = n.bottomFillColor2), r2;
  }
  function Ys(t, i, n, s) {
    const e2 = { se: i, ot: t, Vt: [n.open, n.high, n.low, n.close], Ib: s };
    return void 0 !== n.color && (e2.V = n.color), e2;
  }
  function Zs(t, i, n, s) {
    const e2 = { se: i, ot: t, Vt: [n.open, n.high, n.low, n.close], Ib: s };
    return void 0 !== n.color && (e2.V = n.color), void 0 !== n.borderColor && (e2.Ot = n.borderColor), void 0 !== n.wickColor && (e2.Zh = n.wickColor), e2;
  }
  function Xs(t, i, n, s, e2) {
    const r2 = m(e2)(n), h2 = Math.max(...r2), l2 = Math.min(...r2), a2 = r2[r2.length - 1], o2 = [a2, h2, l2, a2], _2 = n, { time: u2, color: c2 } = _2;
    return { se: i, ot: t, Vt: o2, Ib: s, He: Hs(_2, ["time", "color"]), V: c2 };
  }
  function Ks(t) {
    return void 0 !== t.Vt;
  }
  function Gs(t, i) {
    return void 0 !== i.customValues && (t.Wb = i.customValues), t;
  }
  function Js(t) {
    return (i, n, s, e2, r2, h2) => (function(t2, i2) {
      return i2 ? i2(t2) : void 0 === (n2 = t2).open && void 0 === n2.value;
      var n2;
    })(s, h2) ? Gs({ ot: i, se: n, Ib: e2 }, s) : Gs(t(i, n, s, e2, r2), s);
  }
  function Qs(t) {
    return { Candlestick: Js(Zs), Bar: Js(Ys), Area: Js(Us), Baseline: Js(qs), Histogram: Js($s), Line: Js($s), Custom: Js(Xs) }[t];
  }
  function te(t) {
    return { se: 0, jb: /* @__PURE__ */ new Map(), ha: t };
  }
  function ie(t, i) {
    if (void 0 !== t && 0 !== t.length) return { Hb: i.key(t[0].ot), $b: i.key(t[t.length - 1].ot) };
  }
  function ne(t) {
    let i;
    return t.forEach(((t2) => {
      void 0 === i && (i = t2.Ib);
    })), m(i);
  }
  var se = class {
    constructor(t) {
      this.Ub = /* @__PURE__ */ new Map(), this.qb = /* @__PURE__ */ new Map(), this.Yb = /* @__PURE__ */ new Map(), this.Zb = [], this.U_ = t;
    }
    S() {
      this.Ub.clear(), this.qb.clear(), this.Yb.clear(), this.Zb = [];
    }
    Xb(t, i) {
      let n = 0 !== this.Ub.size, s = false;
      const e2 = this.qb.get(t);
      if (void 0 !== e2) if (1 === this.qb.size) n = false, s = true, this.Ub.clear();
      else for (const i2 of this.Zb) i2.pointData.jb.delete(t) && (s = true);
      let r2 = [];
      if (0 !== i.length) {
        const n2 = i.map(((t2) => t2.time)), e3 = this.U_.createConverterToInternalObj(i), h3 = Qs(t.Jh()), l2 = t.ya(), a2 = t.Ca();
        r2 = i.map(((i2, r3) => {
          const o2 = e3(i2.time), _2 = this.U_.key(o2);
          let u2 = this.Ub.get(_2);
          void 0 === u2 && (u2 = te(o2), this.Ub.set(_2, u2), s = true);
          const c2 = h3(o2, u2.se, i2, n2[r3], l2, a2);
          return u2.jb.set(t, c2), c2;
        }));
      }
      n && this.Kb(), this.Gb(t, r2);
      let h2 = -1;
      if (s) {
        const t2 = [];
        this.Ub.forEach(((i2) => {
          t2.push({ timeWeight: 0, time: i2.ha, pointData: i2, originalTime: ne(i2.jb) });
        })), t2.sort(((t3, i2) => this.U_.key(t3.time) - this.U_.key(i2.time))), h2 = this.Jb(t2);
      }
      return this.Qb(t, h2, (function(t2, i2, n2) {
        const s2 = ie(t2, n2), e3 = ie(i2, n2);
        if (void 0 !== s2 && void 0 !== e3) return { Ql: s2.$b >= e3.$b && s2.Hb >= e3.Hb };
      })(this.qb.get(t), e2, this.U_));
    }
    fd(t) {
      return this.Xb(t, []);
    }
    tw(t, i) {
      const n = i;
      !(function(t2) {
        void 0 === t2.Ib && (t2.Ib = t2.time);
      })(n), this.U_.preprocessData(i);
      const s = this.U_.createConverterToInternalObj([i])(i.time), e2 = this.Yb.get(t);
      if (void 0 !== e2 && this.U_.key(s) < this.U_.key(e2)) throw new Error(`Cannot update oldest data, last time=${e2}, new time=${s}`);
      let r2 = this.Ub.get(this.U_.key(s));
      const h2 = void 0 === r2;
      void 0 === r2 && (r2 = te(s), this.Ub.set(this.U_.key(s), r2));
      const l2 = Qs(t.Jh()), a2 = t.ya(), o2 = t.Ca(), _2 = l2(s, r2.se, i, n.Ib, a2, o2);
      r2.jb.set(t, _2), this.iw(t, _2);
      const u2 = { Ql: Ks(_2) };
      if (!h2) return this.Qb(t, -1, u2);
      const c2 = { timeWeight: 0, time: r2.ha, pointData: r2, originalTime: ne(r2.jb) }, d2 = Bt(this.Zb, this.U_.key(c2.time), ((t2, i2) => this.U_.key(t2.time) < i2));
      this.Zb.splice(d2, 0, c2);
      for (let t2 = d2; t2 < this.Zb.length; ++t2) ee(this.Zb[t2].pointData, t2);
      return this.U_.fillWeightsForPoints(this.Zb, d2), this.Qb(t, d2, u2);
    }
    iw(t, i) {
      let n = this.qb.get(t);
      void 0 === n && (n = [], this.qb.set(t, n));
      const s = 0 !== n.length ? n[n.length - 1] : null;
      null === s || this.U_.key(i.ot) > this.U_.key(s.ot) ? Ks(i) && n.push(i) : Ks(i) ? n[n.length - 1] = i : n.splice(-1, 1), this.Yb.set(t, i.ot);
    }
    Gb(t, i) {
      0 !== i.length ? (this.qb.set(t, i.filter(Ks)), this.Yb.set(t, i[i.length - 1].ot)) : (this.qb.delete(t), this.Yb.delete(t));
    }
    Kb() {
      for (const t of this.Zb) 0 === t.pointData.jb.size && this.Ub.delete(this.U_.key(t.time));
    }
    Jb(t) {
      let i = -1;
      for (let n = 0; n < this.Zb.length && n < t.length; ++n) {
        const s = this.Zb[n], e2 = t[n];
        if (this.U_.key(s.time) !== this.U_.key(e2.time)) {
          i = n;
          break;
        }
        e2.timeWeight = s.timeWeight, ee(e2.pointData, n);
      }
      if (-1 === i && this.Zb.length !== t.length && (i = Math.min(this.Zb.length, t.length)), -1 === i) return -1;
      for (let n = i; n < t.length; ++n) ee(t[n].pointData, n);
      return this.U_.fillWeightsForPoints(t, i), this.Zb = t, i;
    }
    nw() {
      if (0 === this.qb.size) return null;
      let t = 0;
      return this.qb.forEach(((i) => {
        0 !== i.length && (t = Math.max(t, i[i.length - 1].se));
      })), t;
    }
    Qb(t, i, n) {
      const s = { sw: /* @__PURE__ */ new Map(), St: { Lu: this.nw() } };
      if (-1 !== i) this.qb.forEach(((i2, e2) => {
        s.sw.set(e2, { He: i2, ew: e2 === t ? n : void 0 });
      })), this.qb.has(t) || s.sw.set(t, { He: [], ew: n }), s.St.rw = this.Zb, s.St.hw = i;
      else {
        const i2 = this.qb.get(t);
        s.sw.set(t, { He: i2 || [], ew: n });
      }
      return s;
    }
  };
  function ee(t, i) {
    t.se = i, t.jb.forEach(((t2) => {
      t2.se = i;
    }));
  }
  function re(t) {
    const i = { value: t.Vt[3], time: t.Ib };
    return void 0 !== t.Wb && (i.customValues = t.Wb), i;
  }
  function he(t) {
    const i = re(t);
    return void 0 !== t.V && (i.color = t.V), i;
  }
  function le(t) {
    const i = re(t);
    return void 0 !== t.lt && (i.lineColor = t.lt), void 0 !== t.Ts && (i.topColor = t.Ts), void 0 !== t.Ps && (i.bottomColor = t.Ps), i;
  }
  function ae(t) {
    const i = re(t);
    return void 0 !== t.Pe && (i.topLineColor = t.Pe), void 0 !== t.Re && (i.bottomLineColor = t.Re), void 0 !== t.Se && (i.topFillColor1 = t.Se), void 0 !== t.ke && (i.topFillColor2 = t.ke), void 0 !== t.ye && (i.bottomFillColor1 = t.ye), void 0 !== t.Ce && (i.bottomFillColor2 = t.Ce), i;
  }
  function oe(t) {
    const i = { open: t.Vt[0], high: t.Vt[1], low: t.Vt[2], close: t.Vt[3], time: t.Ib };
    return void 0 !== t.Wb && (i.customValues = t.Wb), i;
  }
  function _e(t) {
    const i = oe(t);
    return void 0 !== t.V && (i.color = t.V), i;
  }
  function ue(t) {
    const i = oe(t), { V: n, Ot: s, Zh: e2 } = t;
    return void 0 !== n && (i.color = n), void 0 !== s && (i.borderColor = s), void 0 !== e2 && (i.wickColor = e2), i;
  }
  function ce(t) {
    return { Area: le, Line: he, Baseline: ae, Histogram: he, Bar: _e, Candlestick: ue, Custom: de }[t];
  }
  function de(t) {
    const i = t.Ib;
    return Object.assign(Object.assign({}, t.He), { time: i });
  }
  var fe = { vertLine: { color: "#9598A1", width: 1, style: 3, visible: true, labelVisible: true, labelBackgroundColor: "#131722" }, horzLine: { color: "#9598A1", width: 1, style: 3, visible: true, labelVisible: true, labelBackgroundColor: "#131722" }, mode: 1 };
  var ve = { vertLines: { color: "#D6DCDE", style: 0, visible: true }, horzLines: { color: "#D6DCDE", style: 0, visible: true } };
  var pe = { background: { type: "solid", color: "#FFFFFF" }, textColor: "#191919", fontSize: 12, fontFamily: N, attributionLogo: true };
  var me = { autoScale: true, mode: 0, invertScale: false, alignLabels: true, borderVisible: true, borderColor: "#2B2B43", entireTextOnly: false, visible: false, ticksVisible: false, scaleMargins: { bottom: 0.1, top: 0.2 }, minimumWidth: 0 };
  var be = { rightOffset: 0, barSpacing: 6, minBarSpacing: 0.5, fixLeftEdge: false, fixRightEdge: false, lockVisibleTimeRangeOnResize: false, rightBarStaysOnScroll: false, borderVisible: true, borderColor: "#2B2B43", visible: true, timeVisible: false, secondsVisible: true, shiftVisibleRangeOnNewBar: true, allowShiftVisibleRangeOnWhitespaceReplacement: false, ticksVisible: false, uniformDistribution: false, minimumHeight: 0, allowBoldLabels: true };
  var we = { color: "rgba(0, 0, 0, 0)", visible: false, fontSize: 48, fontFamily: N, fontStyle: "", text: "", horzAlign: "center", vertAlign: "center" };
  function ge() {
    return { width: 0, height: 0, autoSize: false, layout: pe, crosshair: fe, grid: ve, overlayPriceScales: Object.assign({}, me), leftPriceScale: Object.assign(Object.assign({}, me), { visible: false }), rightPriceScale: Object.assign(Object.assign({}, me), { visible: true }), timeScale: be, watermark: we, localization: { locale: ns ? navigator.language : "", dateFormat: "dd MMM 'yy" }, handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true }, handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true }, mouseWheel: true, pinch: true }, kineticScroll: { mouse: false, touch: true }, trackingMode: { exitMode: 1 } };
  }
  var Me = class {
    constructor(t, i) {
      this.lw = t, this.aw = i;
    }
    applyOptions(t) {
      this.lw.$t().Hc(this.aw, t);
    }
    options() {
      return this.Li().W();
    }
    width() {
      return _t(this.aw) ? this.lw.gb(this.aw) : 0;
    }
    Li() {
      return b(this.lw.$t().$c(this.aw)).Dt;
    }
  };
  function xe(t, i, n) {
    const s = Hs(t, ["time", "originalTime"]), e2 = Object.assign({ time: i }, s);
    return void 0 !== n && (e2.originalTime = n), e2;
  }
  var Se = { color: "#FF0000", price: 0, lineStyle: 2, lineWidth: 1, lineVisible: true, axisLabelVisible: true, title: "", axisLabelColor: "", axisLabelTextColor: "" };
  var ke = class {
    constructor(t) {
      this.Eh = t;
    }
    applyOptions(t) {
      this.Eh.Hh(t);
    }
    options() {
      return this.Eh.W();
    }
    ow() {
      return this.Eh;
    }
  };
  var ye = class {
    constructor(t, i, n, s, e2) {
      this._w = new D(), this.Ls = t, this.uw = i, this.cw = n, this.U_ = e2, this.dw = s;
    }
    S() {
      this._w.S();
    }
    priceFormatter() {
      return this.Ls.ma();
    }
    priceToCoordinate(t) {
      const i = this.Ls.Ct();
      return null === i ? null : this.Ls.Dt().Rt(t, i.Vt);
    }
    coordinateToPrice(t) {
      const i = this.Ls.Ct();
      return null === i ? null : this.Ls.Dt().pn(t, i.Vt);
    }
    barsInLogicalRange(t) {
      if (null === t) return null;
      const i = new yn(new xn(t.from, t.to)).hu(), n = this.Ls.In();
      if (n.Ni()) return null;
      const s = n.hl(i.Vs(), 1), e2 = n.hl(i.ui(), -1), r2 = b(n.sl()), h2 = b(n.An());
      if (null !== s && null !== e2 && s.se > e2.se) return { barsBefore: t.from - r2, barsAfter: h2 - t.to };
      const l2 = { barsBefore: null === s || s.se === r2 ? t.from - r2 : s.se - r2, barsAfter: null === e2 || e2.se === h2 ? h2 - t.to : h2 - e2.se };
      return null !== s && null !== e2 && (l2.from = s.Ib, l2.to = e2.Ib), l2;
    }
    setData(t) {
      this.U_, this.Ls.Jh(), this.uw.fw(this.Ls, t), this.pw("full");
    }
    update(t) {
      this.Ls.Jh(), this.uw.mw(this.Ls, t), this.pw("update");
    }
    dataByIndex(t, i) {
      const n = this.Ls.In().hl(t, i);
      if (null === n) return null;
      return ce(this.seriesType())(n);
    }
    data() {
      const t = ce(this.seriesType());
      return this.Ls.In().ie().map(((i) => t(i)));
    }
    subscribeDataChanged(t) {
      this._w.l(t);
    }
    unsubscribeDataChanged(t) {
      this._w.v(t);
    }
    setMarkers(t) {
      this.U_;
      const i = t.map(((t2) => xe(t2, this.U_.convertHorzItemToInternal(t2.time), t2.time)));
      this.Ls.ia(i);
    }
    markers() {
      return this.Ls.na().map(((t) => xe(t, t.originalTime, void 0)));
    }
    applyOptions(t) {
      this.Ls.Hh(t);
    }
    options() {
      return z(this.Ls.W());
    }
    priceScale() {
      return this.cw.priceScale(this.Ls.Dt().Ta());
    }
    createPriceLine(t) {
      const i = V(z(Se), t), n = this.Ls.sa(i);
      return new ke(n);
    }
    removePriceLine(t) {
      this.Ls.ea(t.ow());
    }
    seriesType() {
      return this.Ls.Jh();
    }
    attachPrimitive(t) {
      this.Ls.Sa(t), t.attached && t.attached({ chart: this.dw, series: this, requestUpdate: () => this.Ls.$t().Xl() });
    }
    detachPrimitive(t) {
      this.Ls.ka(t), t.detached && t.detached();
    }
    pw(t) {
      this._w.M() && this._w.m(t);
    }
  };
  var Ce = class {
    constructor(t, i, n) {
      this.bw = new D(), this.pu = new D(), this.Vm = new D(), this.$i = t, this.kl = t.St(), this.lb = i, this.kl.tc().l(this.ww.bind(this)), this.kl.nc().l(this.gw.bind(this)), this.lb.Em().l(this.Mw.bind(this)), this.U_ = n;
    }
    S() {
      this.kl.tc().p(this), this.kl.nc().p(this), this.lb.Em().p(this), this.bw.S(), this.pu.S(), this.Vm.S();
    }
    scrollPosition() {
      return this.kl.ju();
    }
    scrollToPosition(t, i) {
      i ? this.kl.Gu(t, 1e3) : this.$i.Jn(t);
    }
    scrollToRealTime() {
      this.kl.Ku();
    }
    getVisibleRange() {
      const t = this.kl.Du();
      return null === t ? null : { from: t.from.originalTime, to: t.to.originalTime };
    }
    setVisibleRange(t) {
      const i = { from: this.U_.convertHorzItemToInternal(t.from), to: this.U_.convertHorzItemToInternal(t.to) }, n = this.kl.Au(i);
      this.$i.vd(n);
    }
    getVisibleLogicalRange() {
      const t = this.kl.Ru();
      return null === t ? null : { from: t.Vs(), to: t.ui() };
    }
    setVisibleLogicalRange(t) {
      p(t.from <= t.to, "The from index cannot be after the to index."), this.$i.vd(t);
    }
    resetTimeScale() {
      this.$i.Kn();
    }
    fitContent() {
      this.$i.rc();
    }
    logicalToCoordinate(t) {
      const i = this.$i.St();
      return i.Ni() ? null : i.It(t);
    }
    coordinateToLogical(t) {
      return this.kl.Ni() ? null : this.kl.Eu(t);
    }
    timeToCoordinate(t) {
      const i = this.U_.convertHorzItemToInternal(t), n = this.kl.Da(i, false);
      return null === n ? null : this.kl.It(n);
    }
    coordinateToTime(t) {
      const i = this.$i.St(), n = i.Eu(t), s = i.Ui(n);
      return null === s ? null : s.originalTime;
    }
    width() {
      return this.lb._m().width;
    }
    height() {
      return this.lb._m().height;
    }
    subscribeVisibleTimeRangeChange(t) {
      this.bw.l(t);
    }
    unsubscribeVisibleTimeRangeChange(t) {
      this.bw.v(t);
    }
    subscribeVisibleLogicalRangeChange(t) {
      this.pu.l(t);
    }
    unsubscribeVisibleLogicalRangeChange(t) {
      this.pu.v(t);
    }
    subscribeSizeChange(t) {
      this.Vm.l(t);
    }
    unsubscribeSizeChange(t) {
      this.Vm.v(t);
    }
    applyOptions(t) {
      this.kl.Hh(t);
    }
    options() {
      return Object.assign(Object.assign({}, z(this.kl.W())), { barSpacing: this.kl.he() });
    }
    ww() {
      this.bw.M() && this.bw.m(this.getVisibleRange());
    }
    gw() {
      this.pu.M() && this.pu.m(this.getVisibleLogicalRange());
    }
    Mw(t) {
      this.Vm.m(t.width, t.height);
    }
  };
  function Te(t) {
    if (void 0 === t || "custom" === t.type) return;
    const i = t;
    void 0 !== i.minMove && void 0 === i.precision && (i.precision = (function(t2) {
      if (t2 >= 1) return 0;
      let i2 = 0;
      for (; i2 < 8; i2++) {
        const n = Math.round(t2);
        if (Math.abs(n - t2) < 1e-8) return i2;
        t2 *= 10;
      }
      return i2;
    })(i.minMove));
  }
  function Pe(t) {
    return (function(t2) {
      if (I(t2.handleScale)) {
        const i2 = t2.handleScale;
        t2.handleScale = { axisDoubleClickReset: { time: i2, price: i2 }, axisPressedMouseMove: { time: i2, price: i2 }, mouseWheel: i2, pinch: i2 };
      } else if (void 0 !== t2.handleScale) {
        const { axisPressedMouseMove: i2, axisDoubleClickReset: n } = t2.handleScale;
        I(i2) && (t2.handleScale.axisPressedMouseMove = { time: i2, price: i2 }), I(n) && (t2.handleScale.axisDoubleClickReset = { time: n, price: n });
      }
      const i = t2.handleScroll;
      I(i) && (t2.handleScroll = { horzTouchDrag: i, vertTouchDrag: i, mouseWheel: i, pressedMouseMove: i });
    })(t), t;
  }
  var Re = class {
    constructor(t, i, n) {
      this.xw = /* @__PURE__ */ new Map(), this.Sw = /* @__PURE__ */ new Map(), this.kw = new D(), this.yw = new D(), this.Cw = new D(), this.Tw = new se(i);
      const s = void 0 === n ? z(ge()) : V(z(ge()), Pe(n));
      this.U_ = i, this.lw = new Fs(t, s, i), this.lw.hm().l(((t2) => {
        this.kw.M() && this.kw.m(this.Pw(t2()));
      }), this), this.lw.lm().l(((t2) => {
        this.yw.M() && this.yw.m(this.Pw(t2()));
      }), this), this.lw.Zc().l(((t2) => {
        this.Cw.M() && this.Cw.m(this.Pw(t2()));
      }), this);
      const e2 = this.lw.$t();
      this.Rw = new Ce(e2, this.lw.cb(), this.U_);
    }
    remove() {
      this.lw.hm().p(this), this.lw.lm().p(this), this.lw.Zc().p(this), this.Rw.S(), this.lw.S(), this.xw.clear(), this.Sw.clear(), this.kw.S(), this.yw.S(), this.Cw.S(), this.Tw.S();
    }
    resize(t, i, n) {
      this.autoSizeActive() || this.lw.ob(t, i, n);
    }
    addCustomSeries(t, i) {
      const n = w(t), s = Object.assign(Object.assign({}, _), n.defaultOptions());
      return this.Dw("Custom", s, i, n);
    }
    addAreaSeries(t) {
      return this.Dw("Area", l, t);
    }
    addBaselineSeries(t) {
      return this.Dw("Baseline", a, t);
    }
    addBarSeries(t) {
      return this.Dw("Bar", r, t);
    }
    addCandlestickSeries(t = {}) {
      return (function(t2) {
        void 0 !== t2.borderColor && (t2.borderUpColor = t2.borderColor, t2.borderDownColor = t2.borderColor), void 0 !== t2.wickColor && (t2.wickUpColor = t2.wickColor, t2.wickDownColor = t2.wickColor);
      })(t), this.Dw("Candlestick", e, t);
    }
    addHistogramSeries(t) {
      return this.Dw("Histogram", o, t);
    }
    addLineSeries(t) {
      return this.Dw("Line", h, t);
    }
    removeSeries(t) {
      const i = m(this.xw.get(t)), n = this.Tw.fd(i);
      this.lw.$t().fd(i), this.Vw(n), this.xw.delete(t), this.Sw.delete(i);
    }
    fw(t, i) {
      this.Vw(this.Tw.Xb(t, i));
    }
    mw(t, i) {
      this.Vw(this.Tw.tw(t, i));
    }
    subscribeClick(t) {
      this.kw.l(t);
    }
    unsubscribeClick(t) {
      this.kw.v(t);
    }
    subscribeCrosshairMove(t) {
      this.Cw.l(t);
    }
    unsubscribeCrosshairMove(t) {
      this.Cw.v(t);
    }
    subscribeDblClick(t) {
      this.yw.l(t);
    }
    unsubscribeDblClick(t) {
      this.yw.v(t);
    }
    priceScale(t) {
      return new Me(this.lw, t);
    }
    timeScale() {
      return this.Rw;
    }
    applyOptions(t) {
      this.lw.Hh(Pe(t));
    }
    options() {
      return this.lw.W();
    }
    takeScreenshot() {
      return this.lw.bb();
    }
    autoSizeActive() {
      return this.lw.Sb();
    }
    chartElement() {
      return this.lw.kb();
    }
    paneSize() {
      const t = this.lw.Cb();
      return { height: t.height, width: t.width };
    }
    setCrosshairPosition(t, i, n) {
      const s = this.xw.get(n);
      if (void 0 === s) return;
      const e2 = this.lw.$t().cr(s);
      null !== e2 && this.lw.$t().ld(t, i, e2);
    }
    clearCrosshairPosition() {
      this.lw.$t().ad(true);
    }
    Dw(t, i, n = {}, s) {
      Te(n.priceFormat);
      const e2 = V(z(u), z(i), n), r2 = this.lw.$t().ud(t, e2, s), h2 = new ye(r2, this, this, this, this.U_);
      return this.xw.set(h2, r2), this.Sw.set(r2, h2), h2;
    }
    Vw(t) {
      const i = this.lw.$t();
      i.od(t.St.Lu, t.St.rw, t.St.hw), t.sw.forEach(((t2, i2) => i2.J(t2.He, t2.ew))), i.Fu();
    }
    Ow(t) {
      return m(this.Sw.get(t));
    }
    Pw(t) {
      const i = /* @__PURE__ */ new Map();
      t.Eb.forEach(((t2, n2) => {
        const s = n2.Jh(), e2 = ce(s)(t2);
        if ("Custom" !== s) p(js(e2));
        else {
          const t3 = n2.Ca();
          p(!t3 || false === t3(e2));
        }
        i.set(this.Ow(n2), e2);
      }));
      const n = void 0 !== t.Lb && this.Sw.has(t.Lb) ? this.Ow(t.Lb) : void 0;
      return { time: t.Ib, logical: t.se, point: t.zb, hoveredSeries: n, hoveredObjectId: t.Nb, seriesData: i, sourceEvent: t.Fb };
    }
  };
  function De(t, i, n) {
    let s;
    if (A(t)) {
      const i2 = document.getElementById(t);
      p(null !== i2, `Cannot find element in DOM with id=${t}`), s = i2;
    } else s = t;
    const e2 = new Re(s, i, n);
    return i.setOptions(e2.options()), e2;
  }
  function Ve(t, i) {
    return De(t, new is(), is.Ad(i));
  }
  var Be = Object.assign(Object.assign({}, u), _);

  // src/chartApi.ts
  function normalizeTupleData(data) {
    if (!data) return data;
    const barFromTuple = (t) => ({
      time: t[0],
      open: t[1],
      high: t[2],
      low: t[3],
      close: t[4],
      volume: t[5]
    });
    const pointFromTuple = (t, valueKey = "value") => ({
      time: t[0],
      [valueKey]: t[1]
    });
    const bars = Array.isArray(data.bars) && data.bars.length > 0 && Array.isArray(data.bars[0]) ? data.bars.map(barFromTuple) : data.bars;
    const rsi = Array.isArray(data.rsi) && data.rsi.length > 0 && Array.isArray(data.rsi[0]) ? data.rsi.map((p2) => pointFromTuple(p2)) : data.rsi;
    const vdRsiPoints = data.volumeDeltaRsi && Array.isArray(data.volumeDeltaRsi.rsi) && data.volumeDeltaRsi.rsi.length > 0 && Array.isArray(data.volumeDeltaRsi.rsi[0]) ? data.volumeDeltaRsi.rsi.map((p2) => pointFromTuple(p2)) : data.volumeDeltaRsi?.rsi || [];
    const volumeDelta = Array.isArray(data.volumeDelta) && data.volumeDelta.length > 0 && Array.isArray(data.volumeDelta[0]) ? data.volumeDelta.map((p2) => pointFromTuple(p2, "delta")) : data.volumeDelta;
    return {
      ...data,
      bars,
      rsi,
      volumeDeltaRsi: { rsi: vdRsiPoints },
      volumeDelta
    };
  }
  function normalizeLatestTupleData(data) {
    if (!data) return data;
    const barFromTuple = (t) => ({
      time: t[0],
      open: t[1],
      high: t[2],
      low: t[3],
      close: t[4],
      volume: t[5]
    });
    const pointFromTuple = (t, valueKey = "value") => ({
      time: t[0],
      [valueKey]: t[1]
    });
    const latestBar = Array.isArray(data.latestBar) ? barFromTuple(data.latestBar) : data.latestBar;
    const latestRsi = Array.isArray(data.latestRsi) ? pointFromTuple(data.latestRsi) : data.latestRsi;
    const latestVolumeDeltaRsi = Array.isArray(data.latestVolumeDeltaRsi) ? pointFromTuple(data.latestVolumeDeltaRsi) : data.latestVolumeDeltaRsi;
    const latestVolumeDelta = Array.isArray(data.latestVolumeDelta) ? pointFromTuple(data.latestVolumeDelta, "delta") : data.latestVolumeDelta;
    return {
      ...data,
      latestBar,
      latestRsi,
      latestVolumeDeltaRsi,
      latestVolumeDelta
    };
  }
  async function fetchChartData(ticker, interval, options = {}) {
    const params = new URLSearchParams();
    params.set("format", "tuple");
    if (Number.isFinite(options.vdRsiLength)) {
      params.set("vdRsiLength", String(Math.max(1, Math.floor(Number(options.vdRsiLength)))));
    }
    if (typeof options.vdSourceInterval === "string" && options.vdSourceInterval) {
      params.set("vdSourceInterval", options.vdSourceInterval);
    }
    if (typeof options.vdRsiSourceInterval === "string" && options.vdRsiSourceInterval) {
      params.set("vdRsiSourceInterval", options.vdRsiSourceInterval);
    }
    const query = params.toString();
    const url = `/api/chart?ticker=${encodeURIComponent(ticker)}&interval=${interval}${query ? `&${query}` : ""}`;
    const response = await fetch(url, { signal: options.signal });
    if (typeof options.onResponseMeta === "function") {
      options.onResponseMeta({
        status: response.status,
        chartCacheHeader: response.headers.get("x-chart-cache")
      });
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Failed to fetch chart data" }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const json = await response.json();
    return normalizeTupleData(json);
  }
  async function fetchChartLatestData(ticker, interval, options = {}) {
    const params = new URLSearchParams();
    params.set("format", "tuple");
    if (Number.isFinite(options.vdRsiLength)) {
      params.set("vdRsiLength", String(Math.max(1, Math.floor(Number(options.vdRsiLength)))));
    }
    if (typeof options.vdSourceInterval === "string" && options.vdSourceInterval) {
      params.set("vdSourceInterval", options.vdSourceInterval);
    }
    if (typeof options.vdRsiSourceInterval === "string" && options.vdRsiSourceInterval) {
      params.set("vdRsiSourceInterval", options.vdRsiSourceInterval);
    }
    const query = params.toString();
    const url = `/api/chart/latest?ticker=${encodeURIComponent(ticker)}&interval=${interval}${query ? `&${query}` : ""}`;
    const response = await fetch(url, { signal: options.signal });
    if (typeof options.onResponseMeta === "function") {
      options.onResponseMeta({
        status: response.status,
        chartCacheHeader: response.headers.get("x-chart-cache")
      });
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Failed to fetch latest chart data" }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const json = await response.json();
    return normalizeLatestTupleData(json);
  }

  // src/rsi.ts
  var _RSIChart = class _RSIChart {
    constructor(options) {
      __publicField(this, "container");
      __publicField(this, "chart");
      __publicField(this, "series");
      __publicField(this, "lineTools");
      __publicField(this, "displayMode");
      __publicField(this, "lineColor", "#58a6ff");
      __publicField(this, "midlineColor", "#ffffff");
      __publicField(this, "midlineStyle", "dotted");
      __publicField(this, "data");
      __publicField(this, "seriesData", []);
      __publicField(this, "referenceLines", []);
      __publicField(this, "midlinePriceLine", null);
      __publicField(this, "priceData", []);
      __publicField(this, "priceByTime", /* @__PURE__ */ new Map());
      __publicField(this, "indexByTime", /* @__PURE__ */ new Map());
      __publicField(this, "divergencePointTimeKeys", /* @__PURE__ */ new Set());
      __publicField(this, "divergenceToolActive", false);
      __publicField(this, "highlightSeries", null);
      __publicField(this, "firstPoint", null);
      __publicField(this, "divergencePoints", []);
      __publicField(this, "trendLineSeriesList", []);
      __publicField(this, "trendlineCrossLabels", []);
      __publicField(this, "trendlineDefinitions", []);
      __publicField(this, "timelineSeries", null);
      __publicField(this, "suppressExternalSync", false);
      __publicField(this, "onTrendLineDrawn");
      this.container = options.container;
      this.displayMode = options.displayMode;
      this.lineColor = options.lineColor || this.lineColor;
      this.midlineColor = options.midlineColor || this.midlineColor;
      this.midlineStyle = options.midlineStyle || this.midlineStyle;
      this.data = this.normalizeRSIData(options.data);
      this.priceData = options.priceData || [];
      this.rebuildLookupMaps();
      this.seriesData = this.buildSeriesData(this.data, this.priceData);
      this.onTrendLineDrawn = options.onTrendLineDrawn;
      this.chart = LightweightCharts.createChart(options.container, {
        height: 400,
        layout: {
          background: { color: "#0d1117" },
          textColor: "#c9d1d9",
          fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
          attributionLogo: false
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { visible: false }
        },
        timeScale: {
          visible: true,
          timeVisible: true,
          secondsVisible: false,
          borderVisible: true,
          ticksVisible: true,
          fixRightEdge: false,
          rightBarStaysOnScroll: false,
          rightOffset: 10,
          tickMarkFormatter: (time, tickMarkType) => this.formatTickMark(time, tickMarkType),
          borderColor: "#21262d"
          // Show time scale at bottom of RSI chart
        },
        rightPriceScale: {
          borderColor: "#21262d",
          minimumWidth: _RSIChart.SCALE_MIN_WIDTH_PX,
          entireTextOnly: true,
          // Default view: 20-80 range (20% margin top + 20% margin bottom)
          // User can adjust but won't go beyond 0-100 data bounds
          scaleMargins: {
            top: 0.2,
            // 20% margin = hides 0-20 by default
            bottom: 0.2
            // 20% margin = hides 80-100 by default
          }
        },
        crosshair: {
          mode: 1
          // CrosshairMode.Magnet — snaps to nearest data point
        },
        kineticScroll: {
          touch: false,
          mouse: false
        },
        handleScroll: {
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: isMobileTouch,
          mouseWheel: true
        },
        handleScale: {
          mouseWheel: true,
          pinch: true,
          axisPressedMouseMove: {
            time: true,
            price: false
          },
          axisDoubleClickReset: {
            time: true,
            price: false
          }
        }
      });
      this.addReferenceLine(50, "Midline", this.midlineColor, this.midlineStyleToLineStyle(this.midlineStyle));
      this.updateSeries();
      this.updateTimelineSeriesData();
      this.chart.subscribeCrosshairMove((param) => {
        if (this.divergenceToolActive && param && param.time) {
        }
      });
      this.chart.subscribeClick((param) => {
        if (this.divergenceToolActive && param && param.time) {
          this.detectAndHighlightDivergence(param.time);
        }
      });
      this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        this.refreshTrendlineCrossLabels();
      });
    }
    normalizeRSIData(data) {
      return data.filter((point) => point && (typeof point.time === "string" || typeof point.time === "number") && Number.isFinite(Number(point.value))).map((point) => ({
        ...point,
        value: Math.max(
          _RSIChart.RSI_DATA_MIN,
          Math.min(_RSIChart.RSI_DATA_MAX, Number(point.value))
        )
      }));
    }
    formatRSIScaleLabel(value) {
      if (!Number.isFinite(value)) return "";
      const label = Number(value).toFixed(1);
      return label.length >= _RSIChart.SCALE_LABEL_CHARS ? label : label.padEnd(_RSIChart.SCALE_LABEL_CHARS, " ");
    }
    fixedRSIAutoscaleInfoProvider() {
      return {
        priceRange: {
          minValue: _RSIChart.RSI_AXIS_MIN,
          // 20
          maxValue: _RSIChart.RSI_AXIS_MAX
          // 80
        }
      };
    }
    timeKey(time) {
      return typeof time === "number" ? String(time) : time;
    }
    rebuildLookupMaps() {
      this.priceByTime.clear();
      this.indexByTime.clear();
      for (let i = 0; i < this.data.length; i++) {
        const point = this.data[i];
        this.indexByTime.set(this.timeKey(point.time), i);
      }
      for (const point of this.priceData) {
        const price = Number(point.close);
        if (Number.isFinite(price)) {
          this.priceByTime.set(this.timeKey(point.time), price);
        }
      }
    }
    toDateFromScaleTime(time) {
      if (typeof time === "number" && Number.isFinite(time)) {
        return new Date(time * 1e3);
      }
      if (typeof time === "string" && time.trim()) {
        const normalized = time.includes("T") ? time : `${time.replace(" ", "T")}Z`;
        const parsed = new Date(normalized);
        return Number.isFinite(parsed.getTime()) ? parsed : null;
      }
      if (time && typeof time === "object" && Number.isFinite(time.year) && Number.isFinite(time.month) && Number.isFinite(time.day)) {
        return new Date(Date.UTC(Number(time.year), Number(time.month) - 1, Number(time.day), 0, 0, 0));
      }
      return null;
    }
    toUnixSeconds(time) {
      if (typeof time === "number" && Number.isFinite(time)) {
        return time;
      }
      if (typeof time !== "string" || !time.trim()) {
        return null;
      }
      const normalized = time.includes("T") ? time : `${time.replace(" ", "T")}Z`;
      const parsed = new Date(normalized);
      const ms2 = parsed.getTime();
      if (!Number.isFinite(ms2)) return null;
      return Math.floor(ms2 / 1e3);
    }
    formatTickMark(time, tickMarkType) {
      const date = this.toDateFromScaleTime(time);
      if (!date) return "";
      if (tickMarkType === 0) {
        return date.toLocaleDateString("en-US", {
          year: "numeric",
          timeZone: getAppTimeZone()
        });
      }
      if (tickMarkType === 1) {
        return date.toLocaleDateString("en-US", {
          month: "short",
          timeZone: getAppTimeZone()
        });
      }
      return date.toLocaleDateString("en-US", {
        day: "numeric",
        timeZone: getAppTimeZone()
      });
    }
    midlineStyleToLineStyle(style) {
      return style === "solid" ? 0 : 1;
    }
    isSyncSuppressed() {
      return this.suppressExternalSync;
    }
    inferBarStepSeconds() {
      if (this.data.length < 2) return 1800;
      const diffs = [];
      for (let i = 1; i < this.data.length; i++) {
        const prev = this.data[i - 1]?.time;
        const curr = this.data[i]?.time;
        if (typeof prev !== "number" || typeof curr !== "number") continue;
        const diff = curr - prev;
        if (Number.isFinite(diff) && diff > 0 && diff <= 8 * 3600) {
          diffs.push(diff);
        }
      }
      if (diffs.length === 0) return 1800;
      diffs.sort((a2, b2) => a2 - b2);
      return diffs[Math.floor(diffs.length / 2)];
    }
    barsPerTradingDayFromStep(stepSeconds) {
      if (stepSeconds <= 5 * 60) return 78;
      if (stepSeconds <= 15 * 60) return 26;
      if (stepSeconds <= 30 * 60) return 13;
      if (stepSeconds <= 60 * 60) return 7;
      return 2;
    }
    futureBarsForOneYear() {
      const stepSeconds = this.inferBarStepSeconds();
      return this.barsPerTradingDayFromStep(stepSeconds) * 252;
    }
    ensureTimelineSeries() {
      if (this.timelineSeries) return;
      this.timelineSeries = this.chart.addLineSeries({
        color: "rgba(0, 0, 0, 0)",
        lineVisible: false,
        pointMarkersVisible: false,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false
      });
    }
    updateTimelineSeriesData() {
      this.ensureTimelineSeries();
      if (!this.timelineSeries || this.data.length === 0) return;
      const lastTimeSeconds = this.toUnixSeconds(this.data[this.data.length - 1]?.time);
      if (lastTimeSeconds === null) return;
      const timelinePoints = [{ time: lastTimeSeconds }];
      let cursor = lastTimeSeconds;
      let tradingDaysAdded = 0;
      while (tradingDaysAdded < _RSIChart.FUTURE_TIMELINE_TRADING_DAYS) {
        cursor += 86400;
        const dayOfWeek = new Date(cursor * 1e3).getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;
        timelinePoints.push({ time: cursor });
        tradingDaysAdded += 1;
      }
      this.timelineSeries.setData(timelinePoints);
    }
    buildSeriesData(data, priceData) {
      if (!priceData || priceData.length === 0) return data;
      const rsiByTime2 = /* @__PURE__ */ new Map();
      for (const point of data) {
        rsiByTime2.set(String(point.time), Number(point.value));
      }
      return priceData.map((pricePoint) => {
        const value = rsiByTime2.get(String(pricePoint.time));
        if (Number.isFinite(value)) {
          return { time: pricePoint.time, value };
        }
        return { time: pricePoint.time };
      });
    }
    addReferenceLine(value, label, color, lineStyle = 2) {
      this.referenceLines.push({ value, label, color, lineStyle });
      if (this.series) {
        const priceLine = this.series.createPriceLine({
          price: value,
          color,
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: false,
          title: label
        });
        if (label === "Midline") {
          this.midlinePriceLine = priceLine;
        }
      }
    }
    updateSeries() {
      if (this.series) {
        this.chart.removeSeries(this.series);
      }
      this.midlinePriceLine = null;
      if (this.displayMode === "line") {
        this.series = this.chart.addLineSeries({
          color: this.lineColor,
          lineWidth: 1,
          priceFormat: {
            type: "custom",
            minMove: 1,
            formatter: (value) => this.formatRSIScaleLabel(Number(value))
          },
          autoscaleInfoProvider: () => this.fixedRSIAutoscaleInfoProvider(),
          priceLineVisible: false,
          lastValueVisible: false
        });
      } else {
        this.series = this.chart.addHistogramSeries({
          color: this.lineColor,
          priceFormat: {
            type: "custom",
            minMove: 1,
            formatter: (value) => this.formatRSIScaleLabel(Number(value))
          },
          autoscaleInfoProvider: () => this.fixedRSIAutoscaleInfoProvider(),
          priceLineVisible: false,
          lastValueVisible: false
        });
      }
      if (this.displayMode === "line") {
        this.series.setData(this.seriesData);
      } else {
        this.series.setData(this.seriesData.map((d2) => {
          if (Number.isFinite(Number(d2.value))) {
            return {
              time: d2.time,
              value: d2.value,
              color: this.lineColor
            };
          }
          return { time: d2.time };
        }));
      }
      this.referenceLines.forEach((config) => {
        const priceLine = this.series.createPriceLine({
          price: config.value,
          color: config.color,
          lineWidth: 1,
          lineStyle: config.lineStyle,
          axisLabelVisible: false,
          title: config.label
        });
        if (config.label === "Midline") {
          this.midlinePriceLine = priceLine;
        }
      });
    }
    setDisplayMode(mode) {
      if (this.displayMode === mode) return;
      this.displayMode = mode;
      this.updateSeries();
      this.refreshTrendlineCrossLabels();
    }
    setLineColor(color) {
      if (!color) return;
      this.lineColor = color;
      if (this.displayMode === "line" && this.series) {
        this.series.applyOptions({ color });
      } else if (this.displayMode !== "line" && this.series) {
        this.series.applyOptions({ color });
        this.series.setData(this.seriesData.map((d2) => {
          if (Number.isFinite(Number(d2.value))) {
            return {
              time: d2.time,
              value: d2.value,
              color: this.lineColor
            };
          }
          return { time: d2.time };
        }));
      }
    }
    setMidlineOptions(color, style) {
      if (color) this.midlineColor = color;
      if (style) this.midlineStyle = style;
      const lineStyle = this.midlineStyleToLineStyle(this.midlineStyle);
      this.referenceLines = this.referenceLines.map((line) => {
        if (line.label !== "Midline") return line;
        return { ...line, color: this.midlineColor, lineStyle };
      });
      if (this.midlinePriceLine) {
        this.midlinePriceLine.applyOptions({
          color: this.midlineColor,
          lineStyle
        });
      }
    }
    setData(data, priceData) {
      this.clearDivergence();
      this.data = this.normalizeRSIData(data);
      if (priceData) {
        this.priceData = priceData;
      }
      this.rebuildLookupMaps();
      this.seriesData = this.buildSeriesData(this.data, this.priceData);
      if (this.series) {
        if (this.displayMode === "line") {
          this.series.setData(this.seriesData);
        } else {
          this.series.setData(this.seriesData.map((d2) => {
            if (Number.isFinite(Number(d2.value))) {
              return {
                time: d2.time,
                value: d2.value,
                color: this.lineColor
              };
            }
            return { time: d2.time };
          }));
        }
      }
      this.updateTimelineSeriesData();
      this.refreshTrendlineCrossLabels();
    }
    updateLatestPoint(point, latestPricePoint) {
      if (!point || typeof point.time !== "string" && typeof point.time !== "number") return false;
      const nextValueRaw = Number(point.value);
      if (!Number.isFinite(nextValueRaw)) return false;
      if (this.data.length === 0) return false;
      const lastIndex = this.data.length - 1;
      const lastTime = this.data[lastIndex]?.time;
      const lastKey = this.timeKey(lastTime);
      const nextKey = this.timeKey(point.time);
      if (lastKey !== nextKey) return false;
      const nextValue = Math.max(
        _RSIChart.RSI_DATA_MIN,
        Math.min(_RSIChart.RSI_DATA_MAX, nextValueRaw)
      );
      this.data[lastIndex] = {
        ...this.data[lastIndex],
        value: nextValue
      };
      if (latestPricePoint && this.timeKey(latestPricePoint.time) === lastKey) {
        const nextClose = Number(latestPricePoint.close);
        if (Number.isFinite(nextClose)) {
          if (this.priceData.length > 0 && this.timeKey(this.priceData[this.priceData.length - 1].time) === lastKey) {
            this.priceData[this.priceData.length - 1] = {
              ...this.priceData[this.priceData.length - 1],
              close: nextClose
            };
          }
          this.priceByTime.set(lastKey, nextClose);
        }
      }
      if (this.seriesData.length > 0 && this.timeKey(this.seriesData[this.seriesData.length - 1].time) === lastKey) {
        this.seriesData[this.seriesData.length - 1] = {
          time: lastTime,
          value: nextValue
        };
      } else {
        this.seriesData = this.buildSeriesData(this.data, this.priceData);
      }
      if (this.series) {
        if (this.displayMode === "line") {
          this.series.update({ time: lastTime, value: nextValue });
        } else {
          this.series.update({ time: lastTime, value: nextValue, color: this.lineColor });
        }
      }
      this.refreshTrendlineCrossLabels();
      return true;
    }
    getChart() {
      return this.chart;
    }
    getSeries() {
      return this.series;
    }
    getPersistedTrendlines() {
      return this.trendlineDefinitions.map((line) => ({ ...line }));
    }
    restorePersistedTrendlines(trendlines) {
      this.clearDivergence();
      if (!Array.isArray(trendlines) || trendlines.length === 0) return;
      for (const line of trendlines) {
        if (!line) continue;
        const time1 = line.time1;
        const time2 = line.time2;
        const value1 = Number(line.value1);
        const value2 = Number(line.value2);
        if (typeof time1 !== "string" && typeof time1 !== "number" || typeof time2 !== "string" && typeof time2 !== "number") continue;
        if (!Number.isFinite(value1) || !Number.isFinite(value2)) continue;
        this.drawTrendLine(time1, value1, time2, value2, true);
      }
    }
    refreshTrendlineLabels() {
      this.refreshTrendlineCrossLabels();
    }
    getLineTools() {
      return this.lineTools;
    }
    activateDivergenceTool() {
      this.divergenceToolActive = true;
      const container = this.chart.chartElement();
      if (container) {
        container.style.cursor = "crosshair";
      }
    }
    deactivateDivergenceTool() {
      this.divergenceToolActive = false;
      const container = this.chart.chartElement();
      if (container) {
        container.style.cursor = "default";
      }
      this.clearHighlights();
      this.firstPoint = null;
      this.divergencePoints = [];
      this.divergencePointTimeKeys.clear();
    }
    detectAndHighlightDivergence(clickedTime) {
      const clickedKey = this.timeKey(clickedTime);
      const clickedIndex = this.indexByTime.get(clickedKey);
      if (clickedIndex === void 0) {
        console.log("Clicked point not found in RSI data");
        return;
      }
      const clickedRSI = this.data[clickedIndex].value;
      const clickedPrice = this.priceByTime.get(clickedKey);
      if (!Number.isFinite(clickedPrice)) {
        console.log("Corresponding price data not found");
        return;
      }
      const clickedPriceValue = Number(clickedPrice);
      if (!this.firstPoint) {
        this.firstPoint = {
          time: clickedTime,
          rsi: clickedRSI,
          price: clickedPriceValue,
          index: clickedIndex
        };
        this.divergencePoints = [];
        this.divergencePointTimeKeys.clear();
        for (let i = clickedIndex + 1; i < this.data.length; i++) {
          const currentRSI = this.data[i].value;
          const currentTime = this.data[i].time;
          const currentPrice = this.priceByTime.get(this.timeKey(currentTime));
          if (Number.isFinite(currentPrice)) {
            const currentPriceValue = Number(currentPrice);
            const bearishDivergence = currentRSI < clickedRSI && currentPriceValue > clickedPriceValue;
            const bullishDivergence = currentRSI > clickedRSI && currentPriceValue < clickedPriceValue;
            if (bearishDivergence || bullishDivergence) {
              this.divergencePoints.push({ time: currentTime, value: currentRSI });
              this.divergencePointTimeKeys.add(this.timeKey(currentTime));
            }
          }
        }
        console.log(`Found ${this.divergencePoints.length} divergence points from origin (RSI: ${clickedRSI.toFixed(2)}, Price: ${clickedPriceValue.toFixed(2)})`);
        this.highlightPoints(this.divergencePoints);
      } else {
        const isValidSecondPoint = this.divergencePointTimeKeys.has(clickedKey);
        if (!isValidSecondPoint) {
          console.log("Second point must be one of the highlighted divergence points");
          return;
        }
        console.log(`Drawing trend line from (RSI: ${this.firstPoint.rsi.toFixed(2)}) to (RSI: ${clickedRSI.toFixed(2)})`);
        this.drawTrendLine(this.firstPoint.time, this.firstPoint.rsi, clickedTime, clickedRSI);
        this.clearHighlights();
        this.deactivateDivergenceTool();
        this.onTrendLineDrawn?.();
      }
    }
    highlightPoints(points) {
      this.clearHighlights();
      if (points.length === 0) {
        return;
      }
      this.highlightSeries = this.chart.addLineSeries({
        color: "#ff6b6b",
        // Red color for bearish divergence
        lineVisible: false,
        pointMarkersVisible: true,
        pointMarkersRadius: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => this.fixedRSIAutoscaleInfoProvider()
      });
      const step = Math.max(1, Math.ceil(points.length / _RSIChart.MAX_HIGHLIGHT_POINTS));
      const displayPoints = step === 1 ? points : points.filter((_2, index) => index % step === 0);
      this.highlightSeries.setData(displayPoints);
    }
    clearHighlights() {
      if (this.highlightSeries) {
        this.chart.removeSeries(this.highlightSeries);
        this.highlightSeries = null;
      }
    }
    formatMmDdYyFromUnixSeconds(unixSeconds) {
      if (!Number.isFinite(unixSeconds)) return "N/A";
      return getAppTimeZoneFormatter("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "2-digit"
      }).format(new Date(Math.round(Number(unixSeconds)) * 1e3));
    }
    createTrendlineCrossLabelElement(text) {
      const label = document.createElement("div");
      label.className = "trendline-cross-label";
      label.textContent = text;
      label.style.position = "absolute";
      label.style.zIndex = "29";
      label.style.minHeight = "24px";
      label.style.display = "inline-flex";
      label.style.alignItems = "center";
      label.style.padding = "0 8px";
      label.style.borderRadius = "4px";
      label.style.border = "1px solid #30363d";
      label.style.background = "#161b22";
      label.style.color = "#c9d1d9";
      label.style.fontSize = "12px";
      label.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
      label.style.pointerEvents = "none";
      label.style.whiteSpace = "nowrap";
      label.style.transform = "translate(-50%, calc(-100% - 6px))";
      return label;
    }
    refreshTrendlineCrossLabels() {
      if (!this.chart || !this.series || !this.container) return;
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      for (const label of this.trendlineCrossLabels) {
        const x2 = this.chart.timeScale().timeToCoordinate(label.anchorTime);
        const y2 = this.series.priceToCoordinate(label.anchorValue);
        if (!Number.isFinite(x2) || !Number.isFinite(y2) || x2 < 0 || x2 > width || y2 < 0 || y2 > height) {
          label.element.style.display = "none";
          continue;
        }
        label.element.style.display = "inline-flex";
        label.element.style.left = `${Math.round(x2)}px`;
        label.element.style.top = `${Math.round(Math.max(8, y2))}px`;
      }
    }
    clearTrendlineCrossLabels() {
      for (const label of this.trendlineCrossLabels) {
        label.element.remove();
      }
      this.trendlineCrossLabels = [];
    }
    addTrendlineCrossLabel(anchorTime, anchorValue, text) {
      const element = this.createTrendlineCrossLabelElement(text);
      this.container.appendChild(element);
      this.trendlineCrossLabels.push({ element, anchorTime, anchorValue });
      this.refreshTrendlineCrossLabels();
    }
    indexToUnixSeconds(index, lastHistoricalIndex, firstHistoricalTimeSeconds, lastHistoricalTimeSeconds, stepSeconds) {
      if (!Number.isFinite(index)) return null;
      if (index > lastHistoricalIndex) {
        if (lastHistoricalTimeSeconds === null) return null;
        return lastHistoricalTimeSeconds + (index - lastHistoricalIndex) * stepSeconds;
      }
      if (index < 0) {
        if (firstHistoricalTimeSeconds === null) return null;
        return firstHistoricalTimeSeconds + index * stepSeconds;
      }
      const lowerIndex = Math.max(0, Math.floor(index));
      const upperIndex = Math.min(lastHistoricalIndex, Math.ceil(index));
      const lowerTime = this.toUnixSeconds(this.data[lowerIndex]?.time);
      const upperTime = this.toUnixSeconds(this.data[upperIndex]?.time);
      if (lowerIndex === upperIndex) return lowerTime;
      if (Number.isFinite(lowerTime) && Number.isFinite(upperTime)) {
        const ratio = index - lowerIndex;
        return Number(lowerTime) + (Number(upperTime) - Number(lowerTime)) * ratio;
      }
      if (Number.isFinite(lowerTime)) return Number(lowerTime) + (index - lowerIndex) * stepSeconds;
      if (firstHistoricalTimeSeconds === null) return null;
      return firstHistoricalTimeSeconds + index * stepSeconds;
    }
    computeTrendlineMidlineCrossUnixSeconds(index1, value1, slope, lastHistoricalIndex, firstHistoricalTimeSeconds, lastHistoricalTimeSeconds, stepSeconds) {
      if (!Number.isFinite(slope) || Math.abs(slope) < 1e-12) return null;
      const crossIndex = index1 + (_RSIChart.MIDLINE_VALUE - value1) / slope;
      if (!Number.isFinite(crossIndex)) return null;
      return this.indexToUnixSeconds(
        crossIndex,
        lastHistoricalIndex,
        firstHistoricalTimeSeconds,
        lastHistoricalTimeSeconds,
        stepSeconds
      );
    }
    drawTrendLine(time1, value1, time2, value2, recordDefinition = true) {
      const visibleRangeBeforeDraw = this.chart.timeScale().getVisibleLogicalRange?.();
      this.suppressExternalSync = true;
      try {
        const index1 = this.indexByTime.get(this.timeKey(time1));
        const index2 = this.indexByTime.get(this.timeKey(time2));
        if (index1 === void 0 || index2 === void 0) {
          console.error("Could not find indices for trend line points");
          return;
        }
        if (index2 === index1) {
          return;
        }
        const slope = (value2 - value1) / (index2 - index1);
        const trendLineData = [];
        const futureBars = this.futureBarsForOneYear();
        const lastHistoricalIndex = this.data.length - 1;
        const maxIndex = lastHistoricalIndex + futureBars;
        const stepSeconds = this.inferBarStepSeconds();
        const firstHistoricalTimeSeconds = this.toUnixSeconds(this.data[0]?.time);
        const lastHistoricalTime = this.data[lastHistoricalIndex]?.time;
        const lastHistoricalTimeSeconds = this.toUnixSeconds(lastHistoricalTime);
        for (let i = index1; i <= maxIndex; i++) {
          const projectedValue = value1 + slope * (i - index1);
          if (projectedValue < _RSIChart.RSI_DATA_MIN || projectedValue > _RSIChart.RSI_DATA_MAX) {
            break;
          }
          let pointTime = null;
          if (i <= lastHistoricalIndex) {
            pointTime = this.data[i]?.time ?? null;
          } else if (lastHistoricalTimeSeconds !== null) {
            pointTime = lastHistoricalTimeSeconds + (i - lastHistoricalIndex) * stepSeconds;
          }
          if (pointTime === null || pointTime === void 0) continue;
          trendLineData.push({
            time: pointTime,
            value: projectedValue
          });
        }
        if (!trendLineData.length) return;
        const trendLineSeries = this.chart.addLineSeries({
          color: "#ffa500",
          // Orange color for trend line
          lineWidth: 1,
          lineStyle: 0,
          // Solid line
          autoscaleInfoProvider: () => this.fixedRSIAutoscaleInfoProvider(),
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false
        });
        this.trendLineSeriesList.push(trendLineSeries);
        trendLineSeries.setData(trendLineData);
        const crossUnixSeconds = this.computeTrendlineMidlineCrossUnixSeconds(
          index1,
          value1,
          slope,
          lastHistoricalIndex,
          firstHistoricalTimeSeconds,
          lastHistoricalTimeSeconds,
          stepSeconds
        );
        this.addTrendlineCrossLabel(time1, value1, this.formatMmDdYyFromUnixSeconds(crossUnixSeconds));
        if (recordDefinition) {
          this.trendlineDefinitions.push({
            time1,
            value1: Number(value1),
            time2,
            value2: Number(value2)
          });
        }
      } finally {
        if (visibleRangeBeforeDraw) {
          try {
            this.chart.timeScale().setVisibleLogicalRange(visibleRangeBeforeDraw);
          } catch {
          }
        }
        this.suppressExternalSync = false;
      }
    }
    clearDivergence(preserveViewport = false) {
      const visibleRangeBeforeClear = preserveViewport ? this.chart.timeScale().getVisibleLogicalRange?.() : null;
      if (preserveViewport) {
        this.suppressExternalSync = true;
      }
      try {
        this.clearHighlights();
        this.clearTrendlineCrossLabels();
        for (const trendLineSeries of this.trendLineSeriesList) {
          try {
            this.chart.removeSeries(trendLineSeries);
          } catch {
          }
        }
        this.trendLineSeriesList = [];
        this.trendlineDefinitions = [];
        this.firstPoint = null;
        this.divergencePoints = [];
        this.divergencePointTimeKeys.clear();
      } finally {
        if (preserveViewport && visibleRangeBeforeClear) {
          try {
            this.chart.timeScale().setVisibleLogicalRange(visibleRangeBeforeClear);
          } catch {
          }
        }
        if (preserveViewport) {
          this.suppressExternalSync = false;
        }
      }
    }
    resize() {
      if (this.chart) {
        this.chart.resize(this.chart.options().width, 400);
        this.refreshTrendlineCrossLabels();
      }
    }
    destroy() {
      if (this.chart) {
        this.clearTrendlineCrossLabels();
        this.chart.remove();
      }
    }
  };
  __publicField(_RSIChart, "SCALE_LABEL_CHARS", 4);
  __publicField(_RSIChart, "SCALE_MIN_WIDTH_PX", 56);
  __publicField(_RSIChart, "RSI_DATA_MIN", 0);
  __publicField(_RSIChart, "RSI_DATA_MAX", 100);
  __publicField(_RSIChart, "RSI_AXIS_MIN", 20);
  __publicField(_RSIChart, "RSI_AXIS_MAX", 80);
  __publicField(_RSIChart, "MIDLINE_VALUE", 50);
  __publicField(_RSIChart, "MAX_HIGHLIGHT_POINTS", 2e3);
  __publicField(_RSIChart, "FUTURE_TIMELINE_TRADING_DAYS", 252);
  var RSIChart = _RSIChart;

  // src/chart.ts
  var currentChartTicker = null;
  var currentChartInterval = "1day";
  var priceChart = null;
  var candleSeries = null;
  var priceTimelineSeries = null;
  var rsiChart = null;
  var volumeDeltaRsiChart = null;
  var volumeDeltaRsiSeries = null;
  var volumeDeltaRsiTimelineSeries = null;
  var volumeDeltaRsiMidlineLine = null;
  var volumeDeltaChart = null;
  var volumeDeltaHistogramSeries = null;
  var volumeDeltaTimelineSeries = null;
  var volumeDeltaRsiPoints = [];
  var volumeDeltaIndexByTime = /* @__PURE__ */ new Map();
  var volumeDeltaHighlightSeries = null;
  var volumeDeltaTrendLineSeriesList = [];
  var volumeDeltaTrendlineCrossLabels = [];
  var volumeDeltaTrendlineDefinitions = [];
  var volumeDeltaDivergencePointTimeKeys = /* @__PURE__ */ new Set();
  var volumeDeltaFirstPoint = null;
  var volumeDeltaDivergenceToolActive = false;
  var rsiDivergenceToolActive = false;
  var volumeDeltaSuppressSync = false;
  var chartResizeObserver = null;
  var isChartSyncBound = false;
  var latestRenderRequestId = 0;
  var pricePaneContainerEl = null;
  var volumeDeltaPaneContainerEl = null;
  var priceByTime = /* @__PURE__ */ new Map();
  var priceChangeByTime = /* @__PURE__ */ new Map();
  var rsiByTime = /* @__PURE__ */ new Map();
  var volumeDeltaRsiByTime = /* @__PURE__ */ new Map();
  var volumeDeltaByTime = /* @__PURE__ */ new Map();
  var barIndexByTime = /* @__PURE__ */ new Map();
  var currentBars = [];
  var monthBoundaryTimes = [];
  var priceMonthGridOverlayEl = null;
  var volumeDeltaRsiMonthGridOverlayEl = null;
  var volumeDeltaMonthGridOverlayEl = null;
  var rsiMonthGridOverlayEl = null;
  var priceSettingsPanelEl = null;
  var volumeDeltaSettingsPanelEl = null;
  var volumeDeltaRsiSettingsPanelEl = null;
  var rsiSettingsPanelEl = null;
  var volumeDeltaDivergenceSummaryEl = null;
  var rsiDivergencePlotToolActive = false;
  var volumeDeltaRsiDivergencePlotToolActive = false;
  var rsiDivergencePlotSelected = false;
  var volumeDeltaRsiDivergencePlotSelected = false;
  var rsiDivergencePlotStartIndex = null;
  var volumeDeltaRsiDivergencePlotStartIndex = null;
  var rsiDivergenceOverlayEl = null;
  var volumeDeltaRsiDivergenceOverlayEl = null;
  var rsiDivergenceOverlayChart = null;
  var volumeDeltaRsiDivergenceOverlayChart = null;
  var hasLoadedSettingsFromStorage = false;
  var chartFetchAbortController = null;
  var prefetchAbortController = null;
  var chartActivelyLoading = false;
  var intervalSwitchDebounceTimer = null;
  var chartLiveRefreshTimer = null;
  var chartLiveRefreshInFlight = false;
  var chartDataCache = /* @__PURE__ */ new Map();
  var chartCacheHydratedFromSession = false;
  var chartCachePersistTimer = null;
  var chartLayoutRefreshRafId = null;
  var chartPrefetchInFlight = /* @__PURE__ */ new Map();
  var vdfButtonEl = null;
  var vdfRefreshButtonEl = null;
  var vdfLoadingForTicker = null;
  var vdfResultCache = /* @__PURE__ */ new Map();
  var vdZoneOverlayEl = null;
  var vdfAnalysisPanelEl = null;
  var VDF_CACHE_MAX_SIZE = 200;
  var TREND_ICON = "\u270E";
  var ERASE_ICON = "\u232B";
  var DIVERGENCE_ICON = "D";
  var INTERVAL_SWITCH_DEBOUNCE_MS = 120;
  var CHART_LIVE_REFRESH_MS = 15 * 60 * 1e3;
  var CHART_CLIENT_CACHE_TTL_MS = 15 * 60 * 1e3;
  var CHART_CLIENT_CACHE_MAX_ENTRIES = 16;
  var CHART_SESSION_CACHE_KEY = "custom_chart_session_cache_v1";
  var CHART_SESSION_CACHE_MAX_ENTRIES = 6;
  var CHART_SESSION_CACHE_MAX_BYTES = 9e5;
  var RIGHT_MARGIN_BARS = 10;
  var FUTURE_TIMELINE_TRADING_DAYS = 252;
  var SCALE_LABEL_CHARS = 4;
  var SCALE_MIN_WIDTH_PX = 56;
  var INVALID_SYMBOL_MESSAGE = "Invalid symbol";
  var MONTH_GRIDLINE_COLOR = "#21262d";
  var SETTINGS_ICON = "\u2699";
  var SETTINGS_STORAGE_KEY = "custom_chart_settings_v1";
  var isMobileTouch = typeof window !== "undefined" && (window.matchMedia("(max-width: 768px)").matches || "ontouchstart" in window || navigator.maxTouchPoints > 0);
  var TRENDLINES_STORAGE_KEY = "custom_chart_trendlines_v1";
  var TOP_PANE_TICKER_LABEL_CLASS = "top-pane-ticker-label";
  var TOP_PANE_BADGE_CLASS = "top-pane-badge";
  var TOP_PANE_BADGE_START_LEFT_PX = 38;
  var TOP_PANE_BADGE_GAP_PX = 6;
  var PANE_SETTINGS_BUTTON_LEFT_PX = 8;
  var PANE_TOOL_BUTTON_TOP_PX = 8;
  var PANE_TOOL_BUTTON_SIZE_PX = 24;
  var PANE_TOOL_BUTTON_GAP_PX = 6;
  var VOLUME_DELTA_RSI_COLOR = "#2962FF";
  var VOLUME_DELTA_MIDLINE = 50;
  var RSI_MIDLINE_VALUE = 50;
  var VOLUME_DELTA_AXIS_MIN = 20;
  var VOLUME_DELTA_AXIS_MAX = 80;
  var VOLUME_DELTA_DATA_MIN = 0;
  var VOLUME_DELTA_DATA_MAX = 100;
  var VOLUME_DELTA_MAX_HIGHLIGHT_POINTS = 2e3;
  var DIVERGENCE_HIGHLIGHT_COLOR = "#ff6b6b";
  var TRENDLINE_COLOR = "#ffa500";
  var VOLUME_DELTA_POSITIVE_COLOR = "#089981";
  var VOLUME_DELTA_NEGATIVE_COLOR = "#f23645";
  var VOLUME_DELTA_SOURCE_OPTIONS = [
    { value: "1min", label: "1 min" },
    { value: "5min", label: "5 min" },
    { value: "15min", label: "15 min" },
    { value: "30min", label: "30 min" },
    { value: "1hour", label: "1 hour" },
    { value: "4hour", label: "4 hour" }
  ];
  var CHART_PERF_SAMPLE_MAX = 180;
  var PREFETCH_INTERVAL_TARGETS = {
    "5min": [],
    "15min": [],
    "30min": [],
    "1hour": [],
    "4hour": ["1day"],
    "1day": ["4hour", "1week"],
    "1week": ["1day"]
  };
  var DEFAULT_RSI_SETTINGS = {
    length: 14,
    lineColor: "#58a6ff",
    midlineColor: "#ffffff",
    midlineStyle: "dotted"
  };
  var DEFAULT_VOLUME_DELTA_RSI_SETTINGS = {
    length: 14,
    lineColor: VOLUME_DELTA_RSI_COLOR,
    midlineColor: "#ffffff",
    midlineStyle: "dotted",
    sourceInterval: "1min"
  };
  var DEFAULT_VOLUME_DELTA_SETTINGS = {
    sourceInterval: "1min",
    divergenceTable: true,
    divergentPriceBars: true,
    bullishDivergentColor: "#26a69a",
    bearishDivergentColor: "#ef5350",
    neutralDivergentColor: "#8b949e"
  };
  var DEFAULT_PRICE_SETTINGS = {
    maSourceMode: "daily",
    verticalGridlines: false,
    horizontalGridlines: false,
    ma: [
      { enabled: true, type: "EMA", length: 8, color: "#ffa500" },
      { enabled: true, type: "EMA", length: 21, color: "#8a2be2" },
      { enabled: true, type: "SMA", length: 50, color: "#00bcd4" },
      { enabled: false, type: "SMA", length: 200, color: "#90ee90" }
    ]
  };
  var DEFAULT_PANE_ORDER = [
    "vd-chart-container",
    "price-chart-container",
    "rsi-chart-container",
    "vd-rsi-chart-container"
  ];
  var paneOrder = [...DEFAULT_PANE_ORDER];
  var draggedPaneId = null;
  var PANE_HEIGHT_MIN = 120;
  var PANE_HEIGHT_MAX = 600;
  var DEFAULT_PANE_HEIGHTS = {
    "vd-chart-container": 240,
    "price-chart-container": 400,
    "rsi-chart-container": 400,
    "vd-rsi-chart-container": 400
  };
  var paneHeights = {};
  var paneResizeHandlesInstalled = false;
  var crosshairHidden = false;
  var rsiSettings = {
    ...DEFAULT_RSI_SETTINGS
  };
  var volumeDeltaRsiSettings = {
    ...DEFAULT_VOLUME_DELTA_RSI_SETTINGS
  };
  var volumeDeltaSettings = {
    ...DEFAULT_VOLUME_DELTA_SETTINGS
  };
  var priceChartSettings = {
    maSourceMode: DEFAULT_PRICE_SETTINGS.maSourceMode,
    verticalGridlines: DEFAULT_PRICE_SETTINGS.verticalGridlines,
    horizontalGridlines: DEFAULT_PRICE_SETTINGS.horizontalGridlines,
    ma: DEFAULT_PRICE_SETTINGS.ma.map((ma) => ({ ...ma, series: null, values: [] }))
  };
  function ensureMonthGridOverlay(container, pane) {
    const existing = pane === "price" ? priceMonthGridOverlayEl : pane === "volumeDeltaRsi" ? volumeDeltaRsiMonthGridOverlayEl : pane === "volumeDelta" ? volumeDeltaMonthGridOverlayEl : rsiMonthGridOverlayEl;
    if (existing && existing.parentElement === container) return existing;
    const overlay = document.createElement("div");
    const paneClass = pane === "price" ? "month-grid-overlay-price" : pane === "volumeDeltaRsi" ? "month-grid-overlay-volume-delta-rsi" : pane === "volumeDelta" ? "month-grid-overlay-volume-delta" : "month-grid-overlay-rsi";
    overlay.className = `month-grid-overlay ${paneClass}`;
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.right = "0";
    overlay.style.bottom = "0";
    overlay.style.left = "0";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "6";
    container.appendChild(overlay);
    if (pane === "price") {
      priceMonthGridOverlayEl = overlay;
    } else if (pane === "volumeDeltaRsi") {
      volumeDeltaRsiMonthGridOverlayEl = overlay;
    } else if (pane === "volumeDelta") {
      volumeDeltaMonthGridOverlayEl = overlay;
    } else {
      rsiMonthGridOverlayEl = overlay;
    }
    return overlay;
  }
  function unixSecondsFromTimeValue(time) {
    if (typeof time === "number" && Number.isFinite(time)) return time;
    if (typeof time === "string" && time.trim()) {
      const parsed = Date.parse(time.includes("T") ? time : `${time.replace(" ", "T")}Z`);
      if (Number.isFinite(parsed)) return Math.floor(parsed / 1e3);
    }
    return null;
  }
  function toDateFromScaleTime(time) {
    if (typeof time === "number" && Number.isFinite(time)) {
      return new Date(time * 1e3);
    }
    if (typeof time === "string" && time.trim()) {
      const parsed = new Date(time.includes("T") ? time : `${time.replace(" ", "T")}Z`);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
    if (time && typeof time === "object" && Number.isFinite(time.year) && Number.isFinite(time.month) && Number.isFinite(time.day)) {
      return new Date(Date.UTC(Number(time.year), Number(time.month) - 1, Number(time.day), 0, 0, 0));
    }
    return null;
  }
  function formatTimeScaleTickMark(time, tickMarkType) {
    const date = toDateFromScaleTime(time);
    if (!date) return "";
    const appTimeZone = getAppTimeZone();
    if (tickMarkType === 0) {
      return date.toLocaleDateString("en-US", {
        year: "numeric",
        timeZone: appTimeZone
      });
    }
    if (tickMarkType === 1) {
      return date.toLocaleDateString("en-US", {
        month: "short",
        timeZone: appTimeZone
      });
    }
    return date.toLocaleDateString("en-US", {
      day: "numeric",
      timeZone: appTimeZone
    });
  }
  function monthKeyInAppTimeZone(unixSeconds) {
    const parts = getAppTimeZoneFormatter("en-US", {
      year: "numeric",
      month: "2-digit"
    }).formatToParts(new Date(unixSeconds * 1e3));
    const year = parts.find((p2) => p2.type === "year")?.value || "";
    const month = parts.find((p2) => p2.type === "month")?.value || "";
    return `${year}-${month}`;
  }
  function buildMonthBoundaryTimes(bars) {
    const result = [];
    let lastMonthKey = "";
    for (const bar of bars) {
      const unixSeconds = unixSecondsFromTimeValue(bar?.time);
      if (unixSeconds === null) continue;
      const monthKey = monthKeyInAppTimeZone(unixSeconds);
      if (monthKey !== lastMonthKey) {
        result.push(unixSeconds);
        lastMonthKey = monthKey;
      }
    }
    return result;
  }
  function dayKeyInAppTimeZone(unixSeconds) {
    return getAppTimeZoneFormatter("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(unixSeconds * 1e3));
  }
  function buildFutureTimelinePointsFromBars(bars) {
    if (!Array.isArray(bars) || bars.length === 0) return [];
    const lastUnix = unixSecondsFromTimeValue(bars[bars.length - 1]?.time);
    if (!Number.isFinite(lastUnix)) return [];
    const points = [{ time: Number(lastUnix) }];
    let cursor = Number(lastUnix);
    let tradingDaysAdded = 0;
    while (tradingDaysAdded < FUTURE_TIMELINE_TRADING_DAYS) {
      cursor += 86400;
      const dayOfWeek = new Date(cursor * 1e3).getUTCDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) continue;
      points.push({ time: cursor });
      tradingDaysAdded += 1;
    }
    return points;
  }
  function applyFutureTimelineSeriesData(bars) {
    const timelinePoints = buildFutureTimelinePointsFromBars(bars);
    if (priceTimelineSeries) {
      priceTimelineSeries.setData(timelinePoints);
    }
    if (volumeDeltaRsiTimelineSeries) {
      volumeDeltaRsiTimelineSeries.setData(timelinePoints);
    }
    if (volumeDeltaTimelineSeries) {
      volumeDeltaTimelineSeries.setData(timelinePoints);
    }
  }
  function calculateRSIFromCloses(closePrices, period) {
    if (!Array.isArray(closePrices) || closePrices.length === 0) return [];
    if (closePrices.length === 1) return [50];
    const safePeriod = Math.max(1, Math.floor(period || 14));
    const rsiValues = new Array(closePrices.length).fill(50);
    const gains = [];
    const losses = [];
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i < closePrices.length; i++) {
      const change = closePrices[i] - closePrices[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      gains.push(gain);
      losses.push(loss);
      if (i < safePeriod) {
        const window2 = i;
        let gainSum = 0;
        let lossSum = 0;
        for (let j2 = 0; j2 < window2; j2++) {
          gainSum += gains[j2];
          lossSum += losses[j2];
        }
        avgGain = gainSum / window2;
        avgLoss = lossSum / window2;
      } else if (i === safePeriod) {
        let gainSum = 0;
        let lossSum = 0;
        for (let j2 = i - safePeriod; j2 < i; j2++) {
          gainSum += gains[j2];
          lossSum += losses[j2];
        }
        avgGain = gainSum / safePeriod;
        avgLoss = lossSum / safePeriod;
      } else {
        avgGain = (avgGain * (safePeriod - 1) + gain) / safePeriod;
        avgLoss = (avgLoss * (safePeriod - 1) + loss) / safePeriod;
      }
      const rs2 = avgLoss === 0 ? 100 : avgGain / avgLoss;
      const rsi = 100 - 100 / (1 + rs2);
      rsiValues[i] = Number.isFinite(rsi) ? rsi : rsiValues[i - 1];
    }
    rsiValues[0] = rsiValues[1] ?? 50;
    return rsiValues;
  }
  function buildRSISeriesFromBars(bars, period) {
    if (!bars || bars.length === 0) return [];
    const closes = bars.map((bar) => Number(bar.close));
    const rsiValues = calculateRSIFromCloses(closes, period);
    const out = [];
    for (let i = 0; i < bars.length; i++) {
      const raw = rsiValues[i];
      if (!Number.isFinite(raw)) continue;
      out.push({ time: bars[i].time, value: Math.round(raw * 100) / 100 });
    }
    return out;
  }
  function normalizeValueSeries(points) {
    if (!Array.isArray(points)) return [];
    return points.filter((point) => point && (typeof point.time === "string" || typeof point.time === "number") && Number.isFinite(Number(point.value))).map((point) => ({
      time: point.time,
      value: Number(point.value)
    }));
  }
  function buildChartDataCacheKey(ticker, interval) {
    return [
      String(ticker || "").trim().toUpperCase(),
      interval,
      String(volumeDeltaRsiSettings.length),
      volumeDeltaSettings.sourceInterval,
      volumeDeltaRsiSettings.sourceInterval
    ].join("|");
  }
  function isValidChartDataPayload(data) {
    if (!data || typeof data !== "object") return false;
    const candidate = data;
    if (!Array.isArray(candidate.bars) || candidate.bars.length === 0) return false;
    return true;
  }
  function enforceChartDataCacheMaxEntries() {
    while (chartDataCache.size > CHART_CLIENT_CACHE_MAX_ENTRIES) {
      const oldestKey = chartDataCache.keys().next().value;
      if (!oldestKey) break;
      chartDataCache.delete(oldestKey);
    }
  }
  function hydrateChartDataCacheFromSessionIfNeeded() {
    if (chartCacheHydratedFromSession) return;
    chartCacheHydratedFromSession = true;
    if (typeof window === "undefined") return;
    try {
      const raw = window.sessionStorage.getItem(CHART_SESSION_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
      const sortedEntries = [...parsed.entries].filter((entry) => entry && typeof entry.key === "string" && Number.isFinite(entry.updatedAt) && isValidChartDataPayload(entry.data)).sort((a2, b2) => Number(a2.updatedAt) - Number(b2.updatedAt));
      for (const entry of sortedEntries) {
        chartDataCache.set(entry.key, {
          data: entry.data,
          updatedAt: Number(entry.updatedAt)
        });
      }
      enforceChartDataCacheMaxEntries();
    } catch {
    }
  }
  function schedulePersistChartDataCacheToSession() {
    if (typeof window === "undefined") return;
    if (chartCachePersistTimer !== null) return;
    chartCachePersistTimer = window.setTimeout(() => {
      chartCachePersistTimer = null;
      try {
        const newestFirst = Array.from(chartDataCache.entries()).reverse();
        const persistedEntries = [];
        let totalBytes = 0;
        for (const [key, entry] of newestFirst) {
          if (!entry || !entry.data || !Number.isFinite(entry.updatedAt)) continue;
          const candidate = {
            key,
            updatedAt: entry.updatedAt,
            data: entry.data
          };
          const serializedCandidate = JSON.stringify(candidate);
          if (!serializedCandidate) continue;
          if (totalBytes + serializedCandidate.length > CHART_SESSION_CACHE_MAX_BYTES) continue;
          persistedEntries.push(candidate);
          totalBytes += serializedCandidate.length;
          if (persistedEntries.length >= CHART_SESSION_CACHE_MAX_ENTRIES) break;
        }
        const payload = JSON.stringify({
          version: 1,
          entries: persistedEntries
        });
        window.sessionStorage.setItem(CHART_SESSION_CACHE_KEY, payload);
      } catch {
      }
    }, 180);
  }
  function sweepChartDataCache() {
    hydrateChartDataCacheFromSessionIfNeeded();
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of chartDataCache.entries()) {
      if (!entry || !entry.updatedAt || now - entry.updatedAt > CHART_CLIENT_CACHE_TTL_MS) {
        chartDataCache.delete(key);
        changed = true;
      }
    }
    const sizeBefore = chartDataCache.size;
    enforceChartDataCacheMaxEntries();
    if (chartDataCache.size !== sizeBefore) {
      changed = true;
    }
    if (changed) {
      schedulePersistChartDataCacheToSession();
    }
  }
  function getCachedChartData(cacheKey) {
    sweepChartDataCache();
    const cached = chartDataCache.get(cacheKey);
    if (cached) {
      chartDataCache.delete(cacheKey);
      chartDataCache.set(cacheKey, cached);
    }
    return cached ? cached.data : null;
  }
  function setCachedChartData(cacheKey, data) {
    hydrateChartDataCacheFromSessionIfNeeded();
    chartDataCache.delete(cacheKey);
    chartDataCache.set(cacheKey, {
      data,
      updatedAt: Date.now()
    });
    enforceChartDataCacheMaxEntries();
    schedulePersistChartDataCacheToSession();
  }
  function getLastBarSignature(data) {
    const bars = Array.isArray(data?.bars) ? data.bars : [];
    if (!bars.length) return "none";
    const last = bars[bars.length - 1];
    return [
      bars.length,
      timeKey(last.time),
      Number(last.open),
      Number(last.high),
      Number(last.low),
      Number(last.close),
      Number(last.volume)
    ].join("|");
  }
  var chartPerfSamples = {
    "5min": { fetchMs: [], renderMs: [] },
    "15min": { fetchMs: [], renderMs: [] },
    "30min": { fetchMs: [], renderMs: [] },
    "1hour": { fetchMs: [], renderMs: [] },
    "4hour": { fetchMs: [], renderMs: [] },
    "1day": { fetchMs: [], renderMs: [] },
    "1week": { fetchMs: [], renderMs: [] }
  };
  var chartPerfSummary = {
    "5min": { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
    "15min": { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
    "30min": { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
    "1hour": { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
    "4hour": { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
    "1day": { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 },
    "1week": { fetchCount: 0, renderCount: 0, fetchP95Ms: 0, renderP95Ms: 0, responseCacheHit: 0, responseCacheMiss: 0, responseCacheUnknown: 0 }
  };
  function computeP95(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a2, b2) => a2 - b2);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
    return Math.round(sorted[index] * 100) / 100;
  }
  function pushPerfSample(values, ms2) {
    if (!Number.isFinite(ms2) || ms2 < 0) return;
    values.push(Math.round(ms2 * 100) / 100);
    if (values.length > CHART_PERF_SAMPLE_MAX) {
      values.shift();
    }
  }
  function recordChartFetchPerf(interval, durationMs, cacheHeader) {
    const samples = chartPerfSamples[interval];
    const summary = chartPerfSummary[interval];
    pushPerfSample(samples.fetchMs, durationMs);
    summary.fetchCount += 1;
    summary.fetchP95Ms = computeP95(samples.fetchMs);
    if (cacheHeader === "hit") {
      summary.responseCacheHit += 1;
    } else if (cacheHeader === "miss") {
      summary.responseCacheMiss += 1;
    } else {
      summary.responseCacheUnknown += 1;
    }
  }
  function recordChartRenderPerf(interval, durationMs) {
    const samples = chartPerfSamples[interval];
    const summary = chartPerfSummary[interval];
    pushPerfSample(samples.renderMs, durationMs);
    summary.renderCount += 1;
    summary.renderP95Ms = computeP95(samples.renderMs);
  }
  function exposeChartPerfMetrics() {
    if (typeof window === "undefined") return;
    window.__chartPerfMetrics = {
      getSnapshot: () => ({
        byInterval: chartPerfSummary,
        sampleMax: CHART_PERF_SAMPLE_MAX
      })
    };
  }
  async function prefetchRelatedIntervals(ticker, interval) {
    const normalizedTicker = String(ticker || "").trim().toUpperCase();
    if (!normalizedTicker) return;
    const targets = PREFETCH_INTERVAL_TARGETS[interval] || [];
    abortPrefetches();
    const controller = new AbortController();
    prefetchAbortController = controller;
    const promises = [];
    for (const target of targets) {
      if (controller.signal.aborted) break;
      const cacheKey = buildChartDataCacheKey(normalizedTicker, target);
      if (getCachedChartData(cacheKey)) continue;
      if (chartPrefetchInFlight.has(cacheKey)) {
        promises.push(chartPrefetchInFlight.get(cacheKey));
        continue;
      }
      const prefetchPromise = fetchChartData(normalizedTicker, target, {
        vdRsiLength: volumeDeltaRsiSettings.length,
        vdSourceInterval: volumeDeltaSettings.sourceInterval,
        vdRsiSourceInterval: volumeDeltaRsiSettings.sourceInterval,
        signal: controller.signal
      }).then((prefetchedData) => {
        setCachedChartData(cacheKey, prefetchedData);
      }).catch(() => {
      }).finally(() => {
        chartPrefetchInFlight.delete(cacheKey);
      });
      chartPrefetchInFlight.set(cacheKey, prefetchPromise);
      promises.push(prefetchPromise);
    }
    await Promise.allSettled(promises);
    if (!controller.signal.aborted) {
      prefetchNeighborTickers(interval, controller.signal).catch(() => {
      });
    }
  }
  exposeChartPerfMetrics();
  function normalizePaneOrder(order) {
    if (!Array.isArray(order)) return [...DEFAULT_PANE_ORDER];
    const allowed = new Set(DEFAULT_PANE_ORDER);
    const normalized = [];
    for (const candidate of order) {
      if (typeof candidate !== "string") continue;
      if (!allowed.has(candidate)) continue;
      const paneId = candidate;
      if (!normalized.includes(paneId)) normalized.push(paneId);
    }
    for (const paneId of DEFAULT_PANE_ORDER) {
      if (!normalized.includes(paneId)) normalized.push(paneId);
    }
    return normalized;
  }
  function formatVolumeDeltaScaleLabel(value) {
    if (!Number.isFinite(value)) return "";
    const clamped = Math.max(0, Math.min(100, Number(value)));
    let label = "";
    if (Math.abs(clamped) >= 100) {
      label = String(Math.round(clamped));
    } else {
      label = clamped.toFixed(1);
    }
    return label.length >= SCALE_LABEL_CHARS ? label : label.padEnd(SCALE_LABEL_CHARS, " ");
  }
  function normalizeVolumeDeltaSeries(points) {
    if (!Array.isArray(points)) return [];
    return points.filter((point) => point && (typeof point.time === "string" || typeof point.time === "number") && Number.isFinite(Number(point.delta))).map((point) => ({
      time: point.time,
      delta: Number(point.delta)
    }));
  }
  function formatVolumeDeltaHistogramScaleLabel(value) {
    if (!Number.isFinite(value)) return "";
    const sign = value < 0 ? "-" : "";
    const abs = Math.abs(value);
    const budget = SCALE_LABEL_CHARS - sign.length;
    if (budget <= 0) return sign.slice(0, SCALE_LABEL_CHARS);
    const truncateTo = (num, decimals) => {
      if (decimals <= 0) return Math.trunc(num);
      const factor = 10 ** decimals;
      return Math.trunc(num * factor) / factor;
    };
    const trimZeros = (text) => text.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    const tryUnit = (divisor, suffix) => {
      const scaled = abs / divisor;
      if (divisor !== 1 && scaled < 1) return null;
      const numericBudget = budget - suffix.length;
      if (numericBudget <= 0) return null;
      let decimals = 0;
      if (suffix) {
        if (scaled < 10) decimals = 1;
      } else if (scaled >= 10 && scaled < 100) {
        decimals = 1;
      } else if (scaled < 10) {
        decimals = 2;
      }
      while (decimals >= 0) {
        const rendered = trimZeros(truncateTo(scaled, decimals).toFixed(decimals));
        if (rendered.length <= numericBudget) {
          return `${sign}${rendered}${suffix}`;
        }
        decimals -= 1;
      }
      return null;
    };
    const orderedUnits = [
      { divisor: 1e9, suffix: "B" },
      { divisor: 1e6, suffix: "M" },
      { divisor: 1e3, suffix: "K" },
      { divisor: 1, suffix: "" }
    ];
    for (const unit of orderedUnits) {
      const label = tryUnit(unit.divisor, unit.suffix);
      if (label) return label.length >= SCALE_LABEL_CHARS ? label : label.padEnd(SCALE_LABEL_CHARS, " ");
    }
    const fallbackUnits = [
      { divisor: 1e3, suffix: "K" },
      { divisor: 1e6, suffix: "M" },
      { divisor: 1e9, suffix: "B" }
    ];
    for (const unit of fallbackUnits) {
      const numericBudget = budget - unit.suffix.length;
      if (numericBudget <= 0) continue;
      const scaled = abs / unit.divisor;
      const rendered = String(Math.max(1, Math.trunc(scaled)));
      if (rendered.length > numericBudget) continue;
      const label = `${sign}${rendered}${unit.suffix}`;
      return label.length >= SCALE_LABEL_CHARS ? label : label.padEnd(SCALE_LABEL_CHARS, " ");
    }
    return sign ? `${sign}0`.padEnd(SCALE_LABEL_CHARS, " ") : "0".padEnd(SCALE_LABEL_CHARS, " ");
  }
  function normalizePersistedTrendlines(lines) {
    if (!Array.isArray(lines)) return [];
    const out = [];
    for (const line of lines) {
      if (!line || typeof line !== "object") continue;
      const candidate = line;
      const time1 = candidate.time1;
      const time2 = candidate.time2;
      const value1 = Number(candidate.value1);
      const value2 = Number(candidate.value2);
      if (typeof time1 !== "string" && typeof time1 !== "number" || typeof time2 !== "string" && typeof time2 !== "number") continue;
      if (!Number.isFinite(value1) || !Number.isFinite(value2)) continue;
      out.push({ time1, value1, time2, value2 });
    }
    return out;
  }
  function buildTrendlineContextKey(ticker, interval) {
    return `${ticker.toUpperCase()}|${interval}`;
  }
  function loadTrendlineStorage() {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(TRENDLINES_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const normalized = {};
      for (const [key, bundle] of Object.entries(parsed || {})) {
        normalized[key] = {
          rsi: normalizePersistedTrendlines(bundle?.rsi),
          volumeDeltaRsi: normalizePersistedTrendlines(bundle?.volumeDeltaRsi)
        };
      }
      return normalized;
    } catch {
      return {};
    }
  }
  function saveTrendlineStorage(store) {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(TRENDLINES_STORAGE_KEY, JSON.stringify(store));
    } catch {
    }
  }
  function loadPersistedTrendlinesForContext(ticker, interval) {
    const storage = loadTrendlineStorage();
    const bundle = storage[buildTrendlineContextKey(ticker, interval)];
    return {
      rsi: normalizePersistedTrendlines(bundle?.rsi),
      volumeDeltaRsi: normalizePersistedTrendlines(bundle?.volumeDeltaRsi)
    };
  }
  function persistTrendlinesForCurrentContext() {
    if (!currentChartTicker) return;
    const storage = loadTrendlineStorage();
    const key = buildTrendlineContextKey(currentChartTicker, currentChartInterval);
    storage[key] = {
      rsi: rsiChart?.getPersistedTrendlines() ?? [],
      volumeDeltaRsi: volumeDeltaTrendlineDefinitions.map((line) => ({ ...line }))
    };
    saveTrendlineStorage(storage);
  }
  function persistSettingsToStorage() {
    if (typeof window === "undefined") return;
    try {
      const payload = {
        price: {
          maSourceMode: priceChartSettings.maSourceMode,
          verticalGridlines: priceChartSettings.verticalGridlines,
          horizontalGridlines: priceChartSettings.horizontalGridlines,
          ma: priceChartSettings.ma.map((ma) => ({
            enabled: ma.enabled,
            type: ma.type,
            length: ma.length,
            color: ma.color
          }))
        },
        rsi: {
          length: rsiSettings.length,
          lineColor: rsiSettings.lineColor,
          midlineColor: rsiSettings.midlineColor,
          midlineStyle: rsiSettings.midlineStyle
        },
        volumeDelta: {
          sourceInterval: volumeDeltaSettings.sourceInterval,
          divergenceTable: volumeDeltaSettings.divergenceTable,
          divergentPriceBars: volumeDeltaSettings.divergentPriceBars,
          bullishDivergentColor: volumeDeltaSettings.bullishDivergentColor,
          bearishDivergentColor: volumeDeltaSettings.bearishDivergentColor,
          neutralDivergentColor: volumeDeltaSettings.neutralDivergentColor
        },
        volumeDeltaRsi: {
          length: volumeDeltaRsiSettings.length,
          lineColor: volumeDeltaRsiSettings.lineColor,
          midlineColor: volumeDeltaRsiSettings.midlineColor,
          midlineStyle: volumeDeltaRsiSettings.midlineStyle,
          sourceInterval: volumeDeltaRsiSettings.sourceInterval
        },
        paneOrder: [...paneOrder],
        paneHeights: { ...paneHeights }
      };
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
    }
  }
  function ensureSettingsLoadedFromStorage() {
    if (hasLoadedSettingsFromStorage || typeof window === "undefined") return;
    hasLoadedSettingsFromStorage = true;
    try {
      const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const persistedPrice = parsed?.price;
      if (persistedPrice) {
        priceChartSettings.maSourceMode = persistedPrice.maSourceMode === "timeframe" ? "timeframe" : "daily";
        if (typeof persistedPrice.verticalGridlines === "boolean") {
          priceChartSettings.verticalGridlines = persistedPrice.verticalGridlines;
        }
        if (typeof persistedPrice.horizontalGridlines === "boolean") {
          priceChartSettings.horizontalGridlines = persistedPrice.horizontalGridlines;
        }
        if (Array.isArray(persistedPrice.ma)) {
          for (let i = 0; i < priceChartSettings.ma.length; i++) {
            const persisted = persistedPrice.ma[i];
            if (!persisted) continue;
            priceChartSettings.ma[i].enabled = Boolean(persisted.enabled);
            priceChartSettings.ma[i].type = persisted.type === "EMA" ? "EMA" : "SMA";
            priceChartSettings.ma[i].length = Math.max(1, Math.floor(Number(persisted.length) || priceChartSettings.ma[i].length));
            if (typeof persisted.color === "string" && persisted.color.trim()) {
              priceChartSettings.ma[i].color = persisted.color;
            }
          }
        }
      }
      const persistedRSI = parsed?.rsi;
      if (persistedRSI) {
        rsiSettings.length = Math.max(1, Math.floor(Number(persistedRSI.length) || rsiSettings.length));
        if (typeof persistedRSI.lineColor === "string" && persistedRSI.lineColor.trim()) {
          rsiSettings.lineColor = persistedRSI.lineColor;
        }
        if (typeof persistedRSI.midlineColor === "string" && persistedRSI.midlineColor.trim()) {
          rsiSettings.midlineColor = persistedRSI.midlineColor;
        }
        rsiSettings.midlineStyle = persistedRSI.midlineStyle === "solid" ? "solid" : "dotted";
      }
      const persistedVolumeDelta = parsed?.volumeDelta;
      if (persistedVolumeDelta) {
        const source = String(persistedVolumeDelta.sourceInterval || "");
        if (source === "1min" || source === "5min" || source === "15min" || source === "30min" || source === "1hour" || source === "4hour") {
          volumeDeltaSettings.sourceInterval = source;
        }
        if (typeof persistedVolumeDelta.divergenceTable === "boolean") {
          volumeDeltaSettings.divergenceTable = persistedVolumeDelta.divergenceTable;
        }
        if (typeof persistedVolumeDelta.divergentPriceBars === "boolean") {
          volumeDeltaSettings.divergentPriceBars = persistedVolumeDelta.divergentPriceBars;
        }
        if (typeof persistedVolumeDelta.bullishDivergentColor === "string" && persistedVolumeDelta.bullishDivergentColor.trim()) {
          volumeDeltaSettings.bullishDivergentColor = persistedVolumeDelta.bullishDivergentColor;
        }
        if (typeof persistedVolumeDelta.bearishDivergentColor === "string" && persistedVolumeDelta.bearishDivergentColor.trim()) {
          volumeDeltaSettings.bearishDivergentColor = persistedVolumeDelta.bearishDivergentColor;
        }
        if (typeof persistedVolumeDelta.neutralDivergentColor === "string" && persistedVolumeDelta.neutralDivergentColor.trim()) {
          volumeDeltaSettings.neutralDivergentColor = persistedVolumeDelta.neutralDivergentColor;
        }
      }
      const persistedVolumeDeltaRSI = parsed?.volumeDeltaRsi;
      if (persistedVolumeDeltaRSI) {
        volumeDeltaRsiSettings.length = Math.max(1, Math.floor(Number(persistedVolumeDeltaRSI.length) || volumeDeltaRsiSettings.length));
        if (typeof persistedVolumeDeltaRSI.lineColor === "string" && persistedVolumeDeltaRSI.lineColor.trim()) {
          volumeDeltaRsiSettings.lineColor = persistedVolumeDeltaRSI.lineColor;
        }
        if (typeof persistedVolumeDeltaRSI.midlineColor === "string" && persistedVolumeDeltaRSI.midlineColor.trim()) {
          volumeDeltaRsiSettings.midlineColor = persistedVolumeDeltaRSI.midlineColor;
        }
        volumeDeltaRsiSettings.midlineStyle = persistedVolumeDeltaRSI.midlineStyle === "solid" ? "solid" : "dotted";
        const source = String(persistedVolumeDeltaRSI.sourceInterval || "");
        if (source === "1min" || source === "5min" || source === "15min" || source === "30min" || source === "1hour" || source === "4hour") {
          volumeDeltaRsiSettings.sourceInterval = source;
        }
      }
      paneOrder = normalizePaneOrder(parsed?.paneOrder);
      if (parsed?.paneHeights && typeof parsed.paneHeights === "object") {
        for (const [id, h2] of Object.entries(parsed.paneHeights)) {
          if (typeof h2 === "number" && h2 >= PANE_HEIGHT_MIN && h2 <= PANE_HEIGHT_MAX) {
            paneHeights[id] = h2;
          }
        }
      }
    } catch {
    }
  }
  function computeSMA(values, length) {
    const period = Math.max(1, Math.floor(length));
    const out = new Array(values.length).fill(null);
    const filled = values.slice();
    let lastFinite = null;
    for (let i = 0; i < filled.length; i++) {
      if (Number.isFinite(filled[i])) {
        lastFinite = filled[i];
      } else if (lastFinite !== null) {
        filled[i] = lastFinite;
      }
    }
    let sum = 0;
    for (let i = 0; i < filled.length; i++) {
      const value = filled[i];
      if (!Number.isFinite(value)) continue;
      sum += value;
      if (i >= period) {
        sum -= filled[i - period];
      }
      if (i >= period - 1) {
        out[i] = sum / period;
      }
    }
    return out;
  }
  function buildDailyMAValuesForBars(bars, type, length) {
    const dayOrder = [];
    const dayCloseByKey = /* @__PURE__ */ new Map();
    const seen = /* @__PURE__ */ new Set();
    for (const bar of bars) {
      const unixSeconds = unixSecondsFromTimeValue(bar?.time);
      const close = Number(bar?.close);
      if (unixSeconds === null || !Number.isFinite(close)) continue;
      const key = dayKeyInAppTimeZone(unixSeconds);
      if (!seen.has(key)) {
        seen.add(key);
        dayOrder.push(key);
      }
      dayCloseByKey.set(key, close);
    }
    const dailyCloses = dayOrder.map((day) => Number(dayCloseByKey.get(day)));
    const dailyMA = type === "EMA" ? computeEMA(dailyCloses, length) : computeSMA(dailyCloses, length);
    const dailyMAByKey = /* @__PURE__ */ new Map();
    for (let i = 0; i < dayOrder.length; i++) {
      dailyMAByKey.set(dayOrder[i], dailyMA[i] ?? null);
    }
    return bars.map((bar) => {
      const unixSeconds = unixSecondsFromTimeValue(bar?.time);
      if (unixSeconds === null) return null;
      return dailyMAByKey.get(dayKeyInAppTimeZone(unixSeconds)) ?? null;
    });
  }
  function computeEMA(values, length) {
    const period = Math.max(1, Math.floor(length));
    const out = new Array(values.length).fill(null);
    if (values.length === 0) return out;
    const filled = values.slice();
    let lastFinite = null;
    for (let i = 0; i < filled.length; i++) {
      if (Number.isFinite(filled[i])) {
        lastFinite = filled[i];
      } else if (lastFinite !== null) {
        filled[i] = lastFinite;
      }
    }
    const alpha = 2 / (period + 1);
    let ema = null;
    for (let i = 0; i < filled.length; i++) {
      const value = filled[i];
      if (!Number.isFinite(value)) continue;
      if (ema === null) {
        let sum = 0;
        let count = 0;
        for (let j2 = i; j2 < filled.length && count < period; j2++) {
          if (Number.isFinite(filled[j2])) {
            sum += filled[j2];
            count++;
          }
        }
        ema = count > 0 ? sum / count : value;
      } else {
        ema = value * alpha + ema * (1 - alpha);
      }
      out[i] = ema;
    }
    return out;
  }
  function isRenderableMaValue(value) {
    const numeric = typeof value === "number" ? value : Number.NaN;
    return Number.isFinite(numeric) && numeric > 0;
  }
  function clearMovingAverageSeries() {
    for (const setting of priceChartSettings.ma) {
      if (setting.series && priceChart) {
        priceChart.removeSeries(setting.series);
        setting.series = null;
      }
      if (!priceChart) {
        setting.series = null;
      }
      setting.values = [];
    }
  }
  function applyMovingAverages() {
    if (!priceChart || !currentBars.length) {
      clearMovingAverageSeries();
      return;
    }
    for (const setting of priceChartSettings.ma) {
      const validLength = Math.max(1, Math.floor(Number(setting.length) || 1));
      setting.length = validLength;
      if (!setting.enabled) {
        if (setting.series) {
          priceChart.removeSeries(setting.series);
          setting.series = null;
        }
        setting.values = [];
        continue;
      }
      if (!setting.series) {
        setting.series = priceChart.addLineSeries({
          color: setting.color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false
        });
      } else {
        setting.series.applyOptions({ color: setting.color });
      }
      const values = priceChartSettings.maSourceMode === "daily" ? buildDailyMAValuesForBars(currentBars, setting.type, validLength) : setting.type === "EMA" ? computeEMA(currentBars.map((bar) => Number(bar.close)), validLength) : computeSMA(currentBars.map((bar) => Number(bar.close)), validLength);
      setting.values = values;
      const maData = currentBars.map((bar, index) => {
        const value = values[index];
        if (!isRenderableMaValue(value)) {
          return { time: bar.time };
        }
        return {
          time: bar.time,
          value
        };
      });
      setting.series.setData(maData);
    }
  }
  function updateMovingAveragesLatestPoint() {
    if (!priceChart || !Array.isArray(currentBars) || currentBars.length === 0) return;
    if (priceChartSettings.maSourceMode === "daily") {
      applyMovingAverages();
      return;
    }
    const lastIndex = currentBars.length - 1;
    const lastBar = currentBars[lastIndex];
    const lastClose = Number(lastBar?.close);
    if (!Number.isFinite(lastClose)) {
      applyMovingAverages();
      return;
    }
    for (const setting of priceChartSettings.ma) {
      if (!setting.enabled || !setting.series) continue;
      const period = Math.max(1, Math.floor(Number(setting.length) || 1));
      let nextValue = null;
      if (setting.type === "EMA") {
        if (lastIndex === 0) {
          nextValue = lastClose;
        } else {
          const prevValue = Number(setting.values[lastIndex - 1]);
          if (!Number.isFinite(prevValue)) {
            applyMovingAverages();
            return;
          }
          const alpha = 2 / (period + 1);
          nextValue = lastClose * alpha + prevValue * (1 - alpha);
        }
      } else {
        if (lastIndex < period - 1) {
          nextValue = null;
        } else {
          let sum = 0;
          for (let i = lastIndex - period + 1; i <= lastIndex; i++) {
            const close = Number(currentBars[i]?.close);
            if (!Number.isFinite(close)) {
              applyMovingAverages();
              return;
            }
            sum += close;
          }
          nextValue = sum / period;
        }
      }
      if (setting.values.length !== currentBars.length) {
        setting.values = new Array(currentBars.length).fill(null);
      }
      setting.values[lastIndex] = isRenderableMaValue(nextValue) ? nextValue : null;
      if (isRenderableMaValue(nextValue)) {
        setting.series.update({ time: lastBar.time, value: nextValue });
      } else {
        setting.series.update({ time: lastBar.time });
      }
    }
  }
  function clearMonthGridOverlay(overlayEl) {
    if (!overlayEl) return;
    overlayEl.innerHTML = "";
  }
  function renderMonthGridLines(chart, overlayEl) {
    if (!chart || !overlayEl) return;
    overlayEl.innerHTML = "";
    if (!priceChartSettings.verticalGridlines) return;
    if (!monthBoundaryTimes.length) return;
    const width = overlayEl.clientWidth || overlayEl.offsetWidth;
    if (!Number.isFinite(width) || width <= 0) return;
    for (const time of monthBoundaryTimes) {
      const x2 = chart.timeScale().timeToCoordinate(time);
      if (!Number.isFinite(x2)) continue;
      if (x2 < 0 || x2 > width) continue;
      const line = document.createElement("div");
      line.style.position = "absolute";
      line.style.top = "0";
      line.style.bottom = "0";
      line.style.left = `${Math.round(x2)}px`;
      line.style.width = "1px";
      line.style.background = MONTH_GRIDLINE_COLOR;
      overlayEl.appendChild(line);
    }
  }
  function refreshMonthGridLines() {
    renderMonthGridLines(priceChart, priceMonthGridOverlayEl);
    renderMonthGridLines(volumeDeltaRsiChart, volumeDeltaRsiMonthGridOverlayEl);
    renderMonthGridLines(volumeDeltaChart, volumeDeltaMonthGridOverlayEl);
    renderMonthGridLines(rsiChart?.getChart(), rsiMonthGridOverlayEl);
    refreshVolumeDeltaTrendlineCrossLabels();
  }
  function scheduleChartLayoutRefresh() {
    if (chartLayoutRefreshRafId !== null) return;
    chartLayoutRefreshRafId = requestAnimationFrame(() => {
      chartLayoutRefreshRafId = null;
      refreshMonthGridLines();
      refreshVDZones();
    });
  }
  function applyPriceGridOptions() {
    if (!priceChart) return;
    priceChart.applyOptions({
      grid: {
        vertLines: { visible: false },
        horzLines: {
          visible: priceChartSettings.horizontalGridlines,
          color: MONTH_GRIDLINE_COLOR
        }
      }
    });
    scheduleChartLayoutRefresh();
  }
  function syncPriceSettingsPanelValues() {
    if (!priceSettingsPanelEl) return;
    const sourceSelect = priceSettingsPanelEl.querySelector('[data-price-setting="ma-source"]');
    const vGrid = priceSettingsPanelEl.querySelector('[data-price-setting="v-grid"]');
    const hGrid = priceSettingsPanelEl.querySelector('[data-price-setting="h-grid"]');
    if (sourceSelect) sourceSelect.value = priceChartSettings.maSourceMode;
    if (vGrid) vGrid.checked = priceChartSettings.verticalGridlines;
    if (hGrid) hGrid.checked = priceChartSettings.horizontalGridlines;
    for (let i = 0; i < priceChartSettings.ma.length; i++) {
      const ma = priceChartSettings.ma[i];
      const enabled = priceSettingsPanelEl.querySelector(`[data-price-setting="ma-enabled-${i}"]`);
      const type = priceSettingsPanelEl.querySelector(`[data-price-setting="ma-type-${i}"]`);
      const length = priceSettingsPanelEl.querySelector(`[data-price-setting="ma-length-${i}"]`);
      const color = priceSettingsPanelEl.querySelector(`[data-price-setting="ma-color-${i}"]`);
      if (enabled) enabled.checked = ma.enabled;
      if (type) type.value = ma.type;
      if (length) length.value = String(ma.length);
      if (color) color.value = ma.color;
    }
  }
  function syncRSISettingsPanelValues() {
    if (!rsiSettingsPanelEl) return;
    const length = rsiSettingsPanelEl.querySelector('[data-rsi-setting="length"]');
    const color = rsiSettingsPanelEl.querySelector('[data-rsi-setting="line-color"]');
    const midlineColor = rsiSettingsPanelEl.querySelector('[data-rsi-setting="midline-color"]');
    const midlineStyle = rsiSettingsPanelEl.querySelector('[data-rsi-setting="midline-style"]');
    if (length) length.value = String(rsiSettings.length);
    if (color) color.value = rsiSettings.lineColor;
    if (midlineColor) midlineColor.value = rsiSettings.midlineColor;
    if (midlineStyle) midlineStyle.value = rsiSettings.midlineStyle;
  }
  function syncVolumeDeltaSettingsPanelValues() {
    if (!volumeDeltaSettingsPanelEl) return;
    const source = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="source-interval"]');
    const divergenceTable = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="divergence-table"]');
    const divergent = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="divergent-price-bars"]');
    const bullish = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="divergent-bullish-color"]');
    const bearish = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="divergent-bearish-color"]');
    const neutral = volumeDeltaSettingsPanelEl.querySelector('[data-vd-setting="divergent-neutral-color"]');
    if (source) source.value = volumeDeltaSettings.sourceInterval;
    if (divergenceTable) divergenceTable.checked = volumeDeltaSettings.divergenceTable;
    if (divergent) divergent.checked = volumeDeltaSettings.divergentPriceBars;
    if (bullish) bullish.value = volumeDeltaSettings.bullishDivergentColor;
    if (bearish) bearish.value = volumeDeltaSettings.bearishDivergentColor;
    if (neutral) neutral.value = volumeDeltaSettings.neutralDivergentColor;
  }
  function syncVolumeDeltaRSISettingsPanelValues() {
    if (!volumeDeltaRsiSettingsPanelEl) return;
    const length = volumeDeltaRsiSettingsPanelEl.querySelector('[data-vd-rsi-setting="length"]');
    const color = volumeDeltaRsiSettingsPanelEl.querySelector('[data-vd-rsi-setting="line-color"]');
    const midlineColor = volumeDeltaRsiSettingsPanelEl.querySelector('[data-vd-rsi-setting="midline-color"]');
    const midlineStyle = volumeDeltaRsiSettingsPanelEl.querySelector('[data-vd-rsi-setting="midline-style"]');
    const source = volumeDeltaRsiSettingsPanelEl.querySelector('[data-vd-rsi-setting="source-interval"]');
    if (length) length.value = String(volumeDeltaRsiSettings.length);
    if (color) color.value = volumeDeltaRsiSettings.lineColor;
    if (midlineColor) midlineColor.value = volumeDeltaRsiSettings.midlineColor;
    if (midlineStyle) midlineStyle.value = volumeDeltaRsiSettings.midlineStyle;
    if (source) source.value = volumeDeltaRsiSettings.sourceInterval;
  }
  function hideSettingsPanels() {
    if (priceSettingsPanelEl) priceSettingsPanelEl.style.display = "none";
    if (volumeDeltaSettingsPanelEl) volumeDeltaSettingsPanelEl.style.display = "none";
    if (volumeDeltaRsiSettingsPanelEl) volumeDeltaRsiSettingsPanelEl.style.display = "none";
    if (rsiSettingsPanelEl) rsiSettingsPanelEl.style.display = "none";
  }
  function getTopPaneId() {
    return normalizePaneOrder(paneOrder)[0];
  }
  function getTopPaneBadgePriority(badge) {
    const role = String(badge.dataset.topPaneBadgeRole || "");
    if (role === "ticker") return 0;
    if (role === "price-change") return 1;
    return 100;
  }
  function getPaneBadgeStartLeft(container) {
    const toolButtons = Array.from(container.querySelectorAll(".pane-settings-btn, .pane-trendline-btn"));
    if (!toolButtons.length) return TOP_PANE_BADGE_START_LEFT_PX;
    const rightEdge = toolButtons.reduce((maxRight, btn) => {
      const right = btn.offsetLeft + btn.offsetWidth;
      return right > maxRight ? right : maxRight;
    }, 0);
    const computed = rightEdge + TOP_PANE_BADGE_GAP_PX;
    return Math.max(TOP_PANE_BADGE_START_LEFT_PX, computed);
  }
  function layoutTopPaneBadges(container) {
    const badges = Array.from(container.querySelectorAll(`.${TOP_PANE_BADGE_CLASS}`)).filter((badge) => badge.style.display !== "none");
    if (!badges.length) return;
    const ordered = badges.map((badge, index) => ({ badge, index, priority: getTopPaneBadgePriority(badge) })).sort((a2, b2) => a2.priority - b2.priority || a2.index - b2.index).map((entry) => entry.badge);
    let left = getPaneBadgeStartLeft(container);
    for (const badge of ordered) {
      badge.style.left = `${left}px`;
      badge.style.top = "8px";
      badge.style.maxWidth = `calc(100% - ${left + 30}px)`;
      const width = Math.ceil(badge.getBoundingClientRect().width || badge.offsetWidth || 0);
      left += Math.max(0, width) + TOP_PANE_BADGE_GAP_PX;
    }
  }
  function openTickerOnTradingView(ticker) {
    const symbol = String(ticker || "").trim().toUpperCase();
    if (!symbol) return;
    const url = `https://www.tradingview.com/symbols/${encodeURIComponent(symbol)}/`;
    window.open(url, "_blank", "noopener,noreferrer");
  }
  function syncTopPaneTickerLabel() {
    const topPaneId = getTopPaneId();
    for (const paneId of DEFAULT_PANE_ORDER) {
      const pane = document.getElementById(paneId);
      if (!pane || !(pane instanceof HTMLElement)) continue;
      const existing = pane.querySelector(`.${TOP_PANE_TICKER_LABEL_CLASS}`);
      if (!existing) continue;
      if (paneId !== topPaneId) {
        existing.remove();
      }
    }
    if (!topPaneId) return;
    const topPane = document.getElementById(topPaneId);
    if (!topPane || !(topPane instanceof HTMLElement)) return;
    const ticker = String(currentChartTicker || "").trim().toUpperCase();
    let label = topPane.querySelector(`.${TOP_PANE_TICKER_LABEL_CLASS}`);
    if (!ticker) {
      if (label) label.remove();
      for (const paneId of DEFAULT_PANE_ORDER) {
        const pane = document.getElementById(paneId);
        if (!pane || !(pane instanceof HTMLElement)) continue;
        layoutTopPaneBadges(pane);
      }
      return;
    }
    if (!label) {
      const startLeft = getPaneBadgeStartLeft(topPane);
      label = document.createElement("div");
      label.className = `${TOP_PANE_TICKER_LABEL_CLASS} ${TOP_PANE_BADGE_CLASS}`;
      label.dataset.topPaneBadgeRole = "ticker";
      label.style.position = "absolute";
      label.style.left = `${startLeft}px`;
      label.style.top = "8px";
      label.style.zIndex = "32";
      label.style.minHeight = "24px";
      label.style.maxWidth = `calc(100% - ${startLeft + 30}px)`;
      label.style.display = "inline-flex";
      label.style.alignItems = "center";
      label.style.padding = "0 8px";
      label.style.borderRadius = "4px";
      label.style.border = "1px solid #30363d";
      label.style.background = "#161b22";
      label.style.color = "#c9d1d9";
      label.style.fontSize = "12px";
      label.style.fontWeight = "600";
      label.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
      label.style.whiteSpace = "nowrap";
      label.style.overflow = "hidden";
      label.style.textOverflow = "ellipsis";
      label.style.pointerEvents = "auto";
      label.style.cursor = "pointer";
      label.title = "Open on TradingView";
      label.setAttribute("role", "link");
      label.tabIndex = 0;
      if (!label.dataset.clickBound) {
        label.addEventListener("click", (event) => {
          event.stopPropagation();
          const el = event.currentTarget;
          openTickerOnTradingView(String(el.dataset.tickerSymbol || ""));
        });
        label.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          const el = event.currentTarget;
          openTickerOnTradingView(String(el.dataset.tickerSymbol || ""));
        });
        label.dataset.clickBound = "1";
      }
      topPane.appendChild(label);
    }
    label.dataset.tickerSymbol = ticker;
    label.textContent = ticker;
    for (const paneId of DEFAULT_PANE_ORDER) {
      const pane = document.getElementById(paneId);
      if (!pane || !(pane instanceof HTMLElement)) continue;
      layoutTopPaneBadges(pane);
    }
  }
  function applyPaneOrderToDom(chartContent) {
    for (const paneId of paneOrder) {
      const pane = document.getElementById(paneId);
      if (!pane || pane.parentElement !== chartContent) continue;
      chartContent.appendChild(pane);
    }
  }
  function movePaneInOrder(movingPaneId, targetPaneId, insertAfter) {
    if (movingPaneId === targetPaneId) return;
    const nextOrder = paneOrder.filter((paneId) => paneId !== movingPaneId);
    const targetIndex = nextOrder.indexOf(targetPaneId);
    if (targetIndex < 0) return;
    const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;
    nextOrder.splice(insertIndex, 0, movingPaneId);
    paneOrder = normalizePaneOrder(nextOrder);
  }
  function clearPaneDragOverState() {
    for (const paneId of DEFAULT_PANE_ORDER) {
      const pane = document.getElementById(paneId);
      if (!pane) continue;
      pane.classList.remove("pane-drag-over");
    }
  }
  function applyPaneOrderAndRefreshLayout(chartContent) {
    applyPaneOrderToDom(chartContent);
    const chartContainer = document.getElementById("price-chart-container");
    const volumeDeltaRsiContainer = document.getElementById("vd-rsi-chart-container");
    const rsiContainer = document.getElementById("rsi-chart-container");
    const volumeDeltaContainer = document.getElementById("vd-chart-container");
    if (chartContainer && volumeDeltaRsiContainer && rsiContainer && volumeDeltaContainer) {
      applyChartSizes(
        chartContainer,
        volumeDeltaRsiContainer,
        rsiContainer,
        volumeDeltaContainer
      );
    }
    applyPaneScaleVisibilityByPosition();
    syncTopPaneTickerLabel();
  }
  function isChartFullscreen() {
    const container = document.getElementById("custom-chart-container");
    return container?.classList.contains("chart-fullscreen") === true;
  }
  function shouldShowPaneScale(paneId) {
    const order = normalizePaneOrder(paneOrder);
    const index = order.indexOf(paneId);
    if (index === 3 && isChartFullscreen()) return false;
    return index === 1 || index === 3;
  }
  function applyChartScaleVisibility(chart, show) {
    if (!chart) return;
    chart.applyOptions({
      rightPriceScale: {
        // Y-axis should always be visible on every pane.
        visible: true
      },
      timeScale: {
        visible: show,
        borderVisible: show,
        ticksVisible: show
      }
    });
  }
  function applyPaneScaleVisibilityByPosition() {
    applyChartScaleVisibility(priceChart, shouldShowPaneScale("price-chart-container"));
    applyChartScaleVisibility(volumeDeltaRsiChart, shouldShowPaneScale("vd-rsi-chart-container"));
    applyChartScaleVisibility(rsiChart?.getChart(), shouldShowPaneScale("rsi-chart-container"));
    applyChartScaleVisibility(volumeDeltaChart, shouldShowPaneScale("vd-chart-container"));
  }
  function ensurePaneReorderHandle(pane, paneId, chartContent) {
    if (!pane.dataset.paneId) {
      pane.dataset.paneId = paneId;
    }
    let handle = pane.querySelector(".pane-order-handle");
    if (!handle) {
      handle = document.createElement("button");
      handle.type = "button";
      handle.className = "pane-order-handle";
      handle.title = "Drag to reorder panes";
      handle.textContent = "";
      handle.setAttribute("aria-label", "Reorder pane");
      pane.appendChild(handle);
    }
    if (!handle.dataset.bound) {
      handle.setAttribute("draggable", "true");
      handle.addEventListener("dragstart", (event) => {
        draggedPaneId = paneId;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", paneId);
        }
        clearPaneDragOverState();
      });
      handle.addEventListener("dragend", () => {
        draggedPaneId = null;
        clearPaneDragOverState();
      });
      handle.dataset.bound = "1";
    }
    if (!pane.dataset.dropBound) {
      pane.addEventListener("dragover", (event) => {
        if (!draggedPaneId) return;
        event.preventDefault();
        pane.classList.add("pane-drag-over");
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      });
      pane.addEventListener("dragleave", () => {
        pane.classList.remove("pane-drag-over");
      });
      pane.addEventListener("drop", (event) => {
        event.preventDefault();
        pane.classList.remove("pane-drag-over");
        const source = draggedPaneId;
        draggedPaneId = null;
        if (!source || source === paneId) return;
        const sourceIndex = paneOrder.indexOf(source);
        const targetIndex = paneOrder.indexOf(paneId);
        const insertAfter = sourceIndex >= 0 && targetIndex >= 0 ? sourceIndex < targetIndex : true;
        movePaneInOrder(source, paneId, insertAfter);
        applyPaneOrderAndRefreshLayout(chartContent);
        persistSettingsToStorage();
      });
      pane.dataset.dropBound = "1";
    }
  }
  function ensurePaneReorderUI(chartContent) {
    paneOrder = normalizePaneOrder(paneOrder);
    applyPaneOrderToDom(chartContent);
    for (const paneId of DEFAULT_PANE_ORDER) {
      const pane = document.getElementById(paneId);
      if (!pane || !(pane instanceof HTMLElement) || pane.parentElement !== chartContent) continue;
      ensurePaneReorderHandle(pane, paneId, chartContent);
    }
    syncTopPaneTickerLabel();
  }
  function applyRSISettings() {
    if (!rsiChart) return;
    const rsiData = buildRSISeriesFromBars(currentBars, rsiSettings.length);
    rsiByTime = new Map(
      rsiData.filter((point) => Number.isFinite(Number(point.value))).map((point) => [timeKey(point.time), Number(point.value)])
    );
    rsiChart.setData(rsiData, currentBars.map((b2) => ({ time: b2.time, close: b2.close })));
    rsiChart.setLineColor(rsiSettings.lineColor);
    rsiChart.setMidlineOptions(rsiSettings.midlineColor, rsiSettings.midlineStyle);
    refreshActiveDivergenceOverlays();
  }
  function midlineStyleToLineStyle(style) {
    return style === "solid" ? 0 : 1;
  }
  function applyVolumeDeltaRSIVisualSettings() {
    if (volumeDeltaRsiSeries) {
      volumeDeltaRsiSeries.applyOptions({
        color: volumeDeltaRsiSettings.lineColor,
        lineWidth: 1
      });
    }
    if (volumeDeltaRsiMidlineLine) {
      volumeDeltaRsiMidlineLine.applyOptions({
        color: volumeDeltaRsiSettings.midlineColor,
        lineStyle: midlineStyleToLineStyle(volumeDeltaRsiSettings.midlineStyle)
      });
    }
    refreshActiveDivergenceOverlays();
  }
  function applyVolumeDeltaRSISettings(refetch) {
    applyVolumeDeltaRSIVisualSettings();
    if (!refetch) return;
    if (!currentChartTicker) return;
    renderCustomChart(currentChartTicker, currentChartInterval);
  }
  function resetPriceSettingsToDefault() {
    clearMovingAverageSeries();
    priceChartSettings.maSourceMode = DEFAULT_PRICE_SETTINGS.maSourceMode;
    priceChartSettings.verticalGridlines = DEFAULT_PRICE_SETTINGS.verticalGridlines;
    priceChartSettings.horizontalGridlines = DEFAULT_PRICE_SETTINGS.horizontalGridlines;
    for (let i = 0; i < priceChartSettings.ma.length; i++) {
      const defaults = DEFAULT_PRICE_SETTINGS.ma[i];
      if (!defaults) continue;
      priceChartSettings.ma[i].enabled = defaults.enabled;
      priceChartSettings.ma[i].type = defaults.type;
      priceChartSettings.ma[i].length = defaults.length;
      priceChartSettings.ma[i].color = defaults.color;
      priceChartSettings.ma[i].series = null;
      priceChartSettings.ma[i].values = [];
    }
    paneOrder = [...DEFAULT_PANE_ORDER];
    const chartContent = document.getElementById("chart-content");
    if (chartContent && chartContent instanceof HTMLElement) {
      applyPaneOrderAndRefreshLayout(chartContent);
    }
    applyPriceGridOptions();
    applyMovingAverages();
    syncPriceSettingsPanelValues();
    persistSettingsToStorage();
  }
  function resetRSISettingsToDefault() {
    rsiSettings.length = DEFAULT_RSI_SETTINGS.length;
    rsiSettings.lineColor = DEFAULT_RSI_SETTINGS.lineColor;
    rsiSettings.midlineColor = DEFAULT_RSI_SETTINGS.midlineColor;
    rsiSettings.midlineStyle = DEFAULT_RSI_SETTINGS.midlineStyle;
    applyRSISettings();
    syncRSISettingsPanelValues();
    persistSettingsToStorage();
  }
  function resetVolumeDeltaSettingsToDefault() {
    volumeDeltaSettings.sourceInterval = DEFAULT_VOLUME_DELTA_SETTINGS.sourceInterval;
    volumeDeltaSettings.divergenceTable = DEFAULT_VOLUME_DELTA_SETTINGS.divergenceTable;
    volumeDeltaSettings.divergentPriceBars = DEFAULT_VOLUME_DELTA_SETTINGS.divergentPriceBars;
    volumeDeltaSettings.bullishDivergentColor = DEFAULT_VOLUME_DELTA_SETTINGS.bullishDivergentColor;
    volumeDeltaSettings.bearishDivergentColor = DEFAULT_VOLUME_DELTA_SETTINGS.bearishDivergentColor;
    volumeDeltaSettings.neutralDivergentColor = DEFAULT_VOLUME_DELTA_SETTINGS.neutralDivergentColor;
    if (currentChartTicker) {
      renderCustomChart(currentChartTicker, currentChartInterval);
    }
    applyPricePaneDivergentBarColors();
    syncVolumeDeltaSettingsPanelValues();
    persistSettingsToStorage();
  }
  function resetVolumeDeltaRSISettingsToDefault() {
    volumeDeltaRsiSettings.length = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.length;
    volumeDeltaRsiSettings.lineColor = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.lineColor;
    volumeDeltaRsiSettings.midlineColor = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.midlineColor;
    volumeDeltaRsiSettings.midlineStyle = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.midlineStyle;
    volumeDeltaRsiSettings.sourceInterval = DEFAULT_VOLUME_DELTA_RSI_SETTINGS.sourceInterval;
    applyVolumeDeltaRSISettings(true);
    syncVolumeDeltaRSISettingsPanelValues();
    persistSettingsToStorage();
  }
  function createSettingsButton(container, pane) {
    const existing = container.querySelector(`.pane-settings-btn[data-pane="${pane}"]`);
    if (existing) return existing;
    const btn = document.createElement("button");
    btn.className = "pane-settings-btn settings-icon-btn";
    btn.dataset.pane = pane;
    btn.type = "button";
    btn.title = pane === "price" ? "Price settings" : pane === "volumeDelta" ? "Volume Delta settings" : pane === "volumeDeltaRsi" ? "Volume Delta RSI settings" : "RSI settings";
    btn.textContent = SETTINGS_ICON;
    btn.style.position = "absolute";
    btn.style.left = `${PANE_SETTINGS_BUTTON_LEFT_PX}px`;
    btn.style.top = `${PANE_TOOL_BUTTON_TOP_PX}px`;
    btn.style.zIndex = "30";
    btn.style.width = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    btn.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    btn.style.borderRadius = "4px";
    container.appendChild(btn);
    return btn;
  }
  function getPaneShortLabel(pane) {
    if (pane === "volumeDelta") return "VD";
    if (pane === "volumeDeltaRsi") return "VD-RSI";
    if (pane === "rsi") return "RSI";
    return "Price";
  }
  function createPaneNameBadge(container, pane) {
    const existing = container.querySelector(`.pane-name-badge[data-pane="${pane}"]`);
    if (existing) return existing;
    const badge = document.createElement("div");
    badge.className = "pane-name-badge";
    badge.dataset.pane = pane;
    badge.textContent = getPaneShortLabel(pane);
    badge.style.position = "absolute";
    badge.style.left = `${PANE_SETTINGS_BUTTON_LEFT_PX}px`;
    badge.style.top = `${PANE_TOOL_BUTTON_TOP_PX + PANE_TOOL_BUTTON_SIZE_PX + PANE_TOOL_BUTTON_GAP_PX}px`;
    badge.style.zIndex = "30";
    badge.style.minWidth = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    badge.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    badge.style.padding = "0 8px";
    badge.style.borderRadius = "4px";
    badge.style.border = "1px solid #30363d";
    badge.style.background = "#161b22";
    badge.style.color = "#c9d1d9";
    badge.style.display = "inline-flex";
    badge.style.alignItems = "center";
    badge.style.justifyContent = "center";
    badge.style.fontSize = "12px";
    badge.style.fontWeight = "600";
    badge.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
    badge.style.pointerEvents = "none";
    badge.style.userSelect = "none";
    container.appendChild(badge);
    return badge;
  }
  function createPaneTrendlineButton(container, pane, action, orderFromSettings) {
    const existing = container.querySelector(`.pane-trendline-btn[data-pane="${pane}"][data-action="${action}"]`);
    if (existing) return existing;
    const btn = document.createElement("button");
    btn.className = "pane-trendline-btn";
    btn.dataset.pane = pane;
    btn.dataset.action = action;
    btn.type = "button";
    btn.title = action === "trend" ? "Draw Trendline" : action === "erase" ? "Erase Trendline" : "Divergence";
    btn.textContent = action === "trend" ? TREND_ICON : action === "erase" ? ERASE_ICON : DIVERGENCE_ICON;
    btn.style.position = "absolute";
    btn.style.left = `${PANE_SETTINGS_BUTTON_LEFT_PX + (orderFromSettings + 1) * (PANE_TOOL_BUTTON_SIZE_PX + PANE_TOOL_BUTTON_GAP_PX)}px`;
    btn.style.top = `${PANE_TOOL_BUTTON_TOP_PX}px`;
    btn.style.zIndex = "30";
    btn.style.width = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    btn.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    btn.style.borderRadius = "4px";
    btn.style.border = "1px solid #30363d";
    btn.style.background = "#161b22";
    btn.style.color = "#c9d1d9";
    btn.style.cursor = "pointer";
    btn.style.padding = "0";
    container.appendChild(btn);
    return btn;
  }
  function getPaneToolButton(pane, action) {
    return document.querySelector(`.pane-trendline-btn[data-pane="${pane}"][data-action="${action}"]`);
  }
  function setPaneToolButtonActive(pane, action, active) {
    const btn = getPaneToolButton(pane, action);
    if (!btn) return;
    btn.classList.toggle("active", active);
    btn.style.background = active ? "#1f6feb" : "#161b22";
    btn.style.color = "#ffffff";
    btn.textContent = action === "trend" ? TREND_ICON : DIVERGENCE_ICON;
  }
  function setPaneTrendlineToolActive(pane, active) {
    setPaneToolButtonActive(pane, "trend", active);
  }
  function getTrendlineCrosshairCueTime() {
    if (!Array.isArray(currentBars) || currentBars.length === 0) return null;
    const fallbackTime = currentBars[currentBars.length - 1]?.time;
    if (typeof fallbackTime !== "string" && typeof fallbackTime !== "number") return null;
    if (!priceChart) return fallbackTime;
    try {
      const visibleRange = priceChart.timeScale().getVisibleLogicalRange?.();
      const from = Number(visibleRange?.from);
      const to = Number(visibleRange?.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        return fallbackTime;
      }
      const centerIndex = Math.round((from + to) / 2);
      const clampedIndex = Math.max(0, Math.min(currentBars.length - 1, centerIndex));
      const candidateTime = currentBars[clampedIndex]?.time;
      if (typeof candidateTime === "string" || typeof candidateTime === "number") {
        return candidateTime;
      }
    } catch {
    }
    return fallbackTime;
  }
  function primeRsiTrendlineCrosshairCue() {
    if (!rsiChart) return;
    const cueTime = getTrendlineCrosshairCueTime();
    if (cueTime === null) return;
    const cueValue = getNearestMappedValueAtOrBefore(cueTime, rsiByTime);
    const chart = rsiChart.getChart?.();
    const series = rsiChart.getSeries?.();
    if (!chart || !series || !Number.isFinite(cueValue)) return;
    try {
      chart.setCrosshairPosition(Number(cueValue), cueTime, series);
    } catch {
    }
  }
  function primeVolumeDeltaRsiTrendlineCrosshairCue() {
    if (!volumeDeltaRsiChart || !volumeDeltaRsiSeries) return;
    const cueTime = getTrendlineCrosshairCueTime();
    if (cueTime === null) return;
    const cueValue = getNearestMappedValueAtOrBefore(cueTime, volumeDeltaRsiByTime);
    if (!Number.isFinite(cueValue)) return;
    try {
      volumeDeltaRsiChart.setCrosshairPosition(Number(cueValue), cueTime, volumeDeltaRsiSeries);
    } catch {
    }
  }
  function toggleRSITrendlineTool() {
    if (!rsiChart) return;
    if (rsiDivergenceToolActive) {
      rsiChart.deactivateDivergenceTool();
      rsiDivergenceToolActive = false;
      setPaneTrendlineToolActive("rsi", false);
      return;
    }
    if (rsiDivergencePlotToolActive) {
      deactivateRsiDivergencePlotTool();
    }
    rsiChart.activateDivergenceTool();
    rsiDivergenceToolActive = true;
    setPaneTrendlineToolActive("rsi", true);
    primeRsiTrendlineCrosshairCue();
  }
  function clearRSITrendlines() {
    rsiChart?.clearDivergence(true);
    rsiChart?.deactivateDivergenceTool();
    rsiDivergenceToolActive = false;
    setPaneTrendlineToolActive("rsi", false);
    persistTrendlinesForCurrentContext();
  }
  function toggleVolumeDeltaRSITrendlineTool() {
    if (!volumeDeltaRsiChart) return;
    if (volumeDeltaDivergenceToolActive) {
      deactivateVolumeDeltaDivergenceTool();
      setPaneTrendlineToolActive("volumeDeltaRsi", false);
      return;
    }
    if (volumeDeltaRsiDivergencePlotToolActive) {
      deactivateVolumeDeltaRsiDivergencePlotTool();
    }
    activateVolumeDeltaDivergenceTool();
    setPaneTrendlineToolActive("volumeDeltaRsi", true);
    primeVolumeDeltaRsiTrendlineCrosshairCue();
  }
  function clearVolumeDeltaRSITrendlines() {
    clearVolumeDeltaDivergence(true);
    deactivateVolumeDeltaDivergenceTool();
    setPaneTrendlineToolActive("volumeDeltaRsi", false);
    persistTrendlinesForCurrentContext();
  }
  function formatDivergenceOverlayTimeLabel(time) {
    const unix = unixSecondsFromTimeValue(time);
    if (unix === null) return "";
    const date = new Date(unix * 1e3);
    if (currentChartInterval === "1day" || currentChartInterval === "1week") {
      return getAppTimeZoneFormatter("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "2-digit"
      }).format(date);
    }
    return date.toLocaleString("en-US", {
      timeZone: getAppTimeZone(),
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }
  function ensureDivergenceOverlay(container, pane) {
    const existing = pane === "rsi" ? rsiDivergenceOverlayEl : volumeDeltaRsiDivergenceOverlayEl;
    if (existing && existing.parentElement === container) {
      existing.style.top = "0";
      existing.style.right = "0";
      existing.style.maxWidth = "100%";
      return existing;
    }
    const overlay = document.createElement("div");
    overlay.className = `divergence-plot-overlay divergence-plot-overlay-${pane}`;
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.right = "0";
    overlay.style.width = "468px";
    overlay.style.maxWidth = "100%";
    overlay.style.height = "286px";
    overlay.style.border = "1px solid #30363d";
    overlay.style.borderRadius = "6px";
    overlay.style.background = "rgba(13, 17, 23, 0.95)";
    overlay.style.backdropFilter = "blur(4px)";
    overlay.style.zIndex = "35";
    overlay.style.pointerEvents = "none";
    overlay.style.display = "none";
    overlay.style.padding = "8px";
    overlay.style.boxSizing = "border-box";
    const canvasWrap = document.createElement("div");
    canvasWrap.style.position = "relative";
    canvasWrap.style.width = "100%";
    canvasWrap.style.height = "100%";
    const canvas = document.createElement("canvas");
    canvas.className = "divergence-plot-overlay-canvas";
    canvasWrap.appendChild(canvas);
    overlay.appendChild(canvasWrap);
    container.appendChild(overlay);
    if (pane === "rsi") {
      rsiDivergenceOverlayEl = overlay;
    } else {
      volumeDeltaRsiDivergenceOverlayEl = overlay;
    }
    return overlay;
  }
  function getDivergenceOverlayChart(pane) {
    return pane === "rsi" ? rsiDivergenceOverlayChart : volumeDeltaRsiDivergenceOverlayChart;
  }
  function setDivergenceOverlayChart(pane, chart) {
    if (pane === "rsi") {
      rsiDivergenceOverlayChart = chart;
    } else {
      volumeDeltaRsiDivergenceOverlayChart = chart;
    }
  }
  function hideDivergenceOverlay(pane) {
    const overlay = pane === "rsi" ? rsiDivergenceOverlayEl : volumeDeltaRsiDivergenceOverlayEl;
    if (overlay) overlay.style.display = "none";
    const chart = getDivergenceOverlayChart(pane);
    if (chart) {
      try {
        chart.destroy();
      } catch {
      }
      setDivergenceOverlayChart(pane, null);
    }
  }
  function findNearestBarIndex(time) {
    if (!Array.isArray(currentBars) || currentBars.length === 0) return null;
    const direct = barIndexByTime.get(timeKey(time));
    if (direct !== void 0) return direct;
    const targetUnix = unixSecondsFromTimeValue(time);
    if (targetUnix === null) return null;
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < currentBars.length; i++) {
      const unix = unixSecondsFromTimeValue(currentBars[i]?.time);
      if (unix === null) continue;
      const distance = Math.abs(unix - targetUnix);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return Number.isFinite(bestDistance) ? bestIndex : null;
  }
  function buildDivergenceOverlayData(startIndex) {
    const labels = [];
    const rsiValues = [];
    const volumeDeltaRsiValues = [];
    for (let i = startIndex; i < currentBars.length; i++) {
      const bar = currentBars[i];
      const key = timeKey(bar.time);
      const rsiValue = Number(rsiByTime.get(key));
      const vdRsiValue = Number(volumeDeltaRsiByTime.get(key));
      if (!Number.isFinite(rsiValue) || !Number.isFinite(vdRsiValue)) continue;
      labels.push(formatDivergenceOverlayTimeLabel(bar.time));
      rsiValues.push(rsiValue);
      volumeDeltaRsiValues.push(vdRsiValue);
    }
    return { labels, rsiValues, volumeDeltaRsiValues };
  }
  function renderDivergenceOverlayForPane(pane, startIndex) {
    const container = pane === "rsi" ? document.getElementById("rsi-chart-container") : document.getElementById("vd-rsi-chart-container");
    if (!container || !(container instanceof HTMLElement)) return;
    const overlay = ensureDivergenceOverlay(container, pane);
    const canvas = overlay.querySelector(".divergence-plot-overlay-canvas");
    if (!canvas) return;
    if (!currentBars.length || startIndex < 0 || startIndex >= currentBars.length) {
      hideDivergenceOverlay(pane);
      return;
    }
    const data = buildDivergenceOverlayData(startIndex);
    if (data.rsiValues.length < 2) {
      hideDivergenceOverlay(pane);
      return;
    }
    overlay.style.display = "block";
    const existingChart = getDivergenceOverlayChart(pane);
    if (existingChart) {
      existingChart.data.labels = data.labels;
      existingChart.data.datasets[0].data = data.rsiValues;
      existingChart.data.datasets[0].borderColor = rsiSettings.lineColor;
      existingChart.data.datasets[1].data = data.volumeDeltaRsiValues;
      existingChart.data.datasets[1].borderColor = volumeDeltaRsiSettings.lineColor;
      existingChart.update("none");
      return;
    }
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: data.labels,
        datasets: [
          {
            label: "RSI",
            data: data.rsiValues,
            borderColor: rsiSettings.lineColor,
            backgroundColor: "transparent",
            borderWidth: 1,
            pointRadius: data.rsiValues.length > 24 ? 0 : 2,
            tension: 0.2
          },
          {
            label: "VD RSI",
            data: data.volumeDeltaRsiValues,
            borderColor: volumeDeltaRsiSettings.lineColor,
            backgroundColor: "transparent",
            borderWidth: 1,
            pointRadius: data.volumeDeltaRsiValues.length > 24 ? 0 : 2,
            tension: 0.2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          mode: "index",
          intersect: false
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: "rgba(22, 27, 34, 0.95)",
            borderColor: "#30363d",
            borderWidth: 1,
            titleColor: "#c9d1d9",
            bodyColor: "#8b949e"
          }
        },
        scales: {
          x: {
            display: false,
            ticks: {
              color: "#8b949e",
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 6,
              font: { size: 10 }
            },
            grid: { color: "rgba(48, 54, 61, 0.22)" }
          },
          y: {
            display: false,
            min: 0,
            max: 100,
            ticks: {
              color: "#8b949e",
              font: { size: 10 }
            },
            grid: { color: "rgba(48, 54, 61, 0.22)" }
          }
        }
      }
    });
    setDivergenceOverlayChart(pane, chart);
  }
  function deactivateRsiDivergencePlotTool() {
    rsiDivergencePlotToolActive = false;
    rsiDivergencePlotSelected = false;
    rsiDivergencePlotStartIndex = null;
    setPaneToolButtonActive("rsi", "divergence", false);
    hideDivergenceOverlay("rsi");
  }
  function deactivateVolumeDeltaRsiDivergencePlotTool() {
    volumeDeltaRsiDivergencePlotToolActive = false;
    volumeDeltaRsiDivergencePlotSelected = false;
    volumeDeltaRsiDivergencePlotStartIndex = null;
    setPaneToolButtonActive("volumeDeltaRsi", "divergence", false);
    hideDivergenceOverlay("volumeDeltaRsi");
  }
  function updateRsiDivergencePlotPoint(time, fromMove) {
    if (!rsiDivergencePlotToolActive) return;
    if (fromMove && !rsiDivergencePlotSelected) return;
    const index = findNearestBarIndex(time);
    if (index === null) return;
    rsiDivergencePlotSelected = true;
    rsiDivergencePlotStartIndex = index;
    renderDivergenceOverlayForPane("rsi", index);
  }
  function updateVolumeDeltaRsiDivergencePlotPoint(time, fromMove) {
    if (!volumeDeltaRsiDivergencePlotToolActive) return;
    if (fromMove && !volumeDeltaRsiDivergencePlotSelected) return;
    const index = findNearestBarIndex(time);
    if (index === null) return;
    volumeDeltaRsiDivergencePlotSelected = true;
    volumeDeltaRsiDivergencePlotStartIndex = index;
    renderDivergenceOverlayForPane("volumeDeltaRsi", index);
  }
  function toggleRsiDivergencePlotTool() {
    if (rsiDivergencePlotToolActive) {
      deactivateRsiDivergencePlotTool();
      return;
    }
    if (rsiDivergenceToolActive) {
      rsiChart?.deactivateDivergenceTool();
      rsiDivergenceToolActive = false;
      setPaneTrendlineToolActive("rsi", false);
    }
    rsiDivergencePlotToolActive = true;
    rsiDivergencePlotSelected = false;
    rsiDivergencePlotStartIndex = null;
    setPaneToolButtonActive("rsi", "divergence", true);
  }
  function toggleVolumeDeltaRsiDivergencePlotTool() {
    if (volumeDeltaRsiDivergencePlotToolActive) {
      deactivateVolumeDeltaRsiDivergencePlotTool();
      return;
    }
    if (volumeDeltaDivergenceToolActive) {
      deactivateVolumeDeltaDivergenceTool();
      setPaneTrendlineToolActive("volumeDeltaRsi", false);
    }
    volumeDeltaRsiDivergencePlotToolActive = true;
    volumeDeltaRsiDivergencePlotSelected = false;
    volumeDeltaRsiDivergencePlotStartIndex = null;
    setPaneToolButtonActive("volumeDeltaRsi", "divergence", true);
  }
  function refreshActiveDivergenceOverlays() {
    if (rsiDivergencePlotToolActive && rsiDivergencePlotSelected && rsiDivergencePlotStartIndex !== null) {
      renderDivergenceOverlayForPane("rsi", rsiDivergencePlotStartIndex);
    }
    if (volumeDeltaRsiDivergencePlotToolActive && volumeDeltaRsiDivergencePlotSelected && volumeDeltaRsiDivergencePlotStartIndex !== null) {
      renderDivergenceOverlayForPane("volumeDeltaRsi", volumeDeltaRsiDivergencePlotStartIndex);
    }
  }
  function deactivateInteractivePaneToolsFromEscape() {
    if (rsiDivergenceToolActive) {
      rsiChart?.deactivateDivergenceTool();
      rsiDivergenceToolActive = false;
      setPaneTrendlineToolActive("rsi", false);
    }
    if (volumeDeltaDivergenceToolActive) {
      deactivateVolumeDeltaDivergenceTool();
      setPaneTrendlineToolActive("volumeDeltaRsi", false);
    }
    if (rsiDivergencePlotToolActive) {
      deactivateRsiDivergencePlotTool();
    }
    if (volumeDeltaRsiDivergencePlotToolActive) {
      deactivateVolumeDeltaRsiDivergencePlotTool();
    }
  }
  function applyUniformSettingsPanelTypography(panel) {
    panel.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    panel.style.fontSize = "12px";
    panel.style.fontWeight = "500";
    panel.style.lineHeight = "1.2";
    panel.querySelectorAll("div, span, label, input, select, button").forEach((el) => {
      el.style.fontFamily = "inherit";
      el.style.fontSize = "inherit";
      el.style.fontWeight = "inherit";
      el.style.fontStyle = "normal";
      el.style.letterSpacing = "normal";
    });
    panel.querySelectorAll("label").forEach((label) => {
      label.style.display = "flex";
      label.style.justifyContent = "space-between";
      label.style.alignItems = "center";
      label.style.gap = "8px";
      label.style.minHeight = "26px";
    });
    panel.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.style.width = "14px";
      checkbox.style.height = "14px";
      checkbox.style.margin = "0";
    });
    panel.querySelectorAll("input, select, button").forEach((control) => {
      control.style.boxSizing = "border-box";
      control.style.lineHeight = "1.2";
    });
  }
  function createPriceSettingsPanel(container) {
    const panel = document.createElement("div");
    panel.className = "pane-settings-panel price-settings-panel";
    panel.style.position = "absolute";
    panel.style.left = "8px";
    panel.style.top = "38px";
    panel.style.zIndex = "31";
    panel.style.width = "280px";
    panel.style.maxWidth = "calc(100% - 16px)";
    panel.style.background = "rgba(22, 27, 34, 0.95)";
    panel.style.border = "1px solid #30363d";
    panel.style.borderRadius = "6px";
    panel.style.padding = "10px";
    panel.style.display = "none";
    panel.style.color = "#c9d1d9";
    panel.style.backdropFilter = "blur(6px)";
    panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">Chart</div>
      <button type="button" data-price-setting="reset" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Vertical gridlines</span>
      <input type="checkbox" data-price-setting="v-grid" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Horizontal gridlines</span>
      <input type="checkbox" data-price-setting="h-grid" />
    </label>
    <label style="margin-bottom:4px;">
      <span>MA source</span>
      <select data-price-setting="ma-source" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        <option value="daily">Daily</option>
        <option value="timeframe">Chart</option>
      </select>
    </label>
    ${priceChartSettings.ma.map((_2, i) => `
      <div style="display:grid; grid-template-columns: 20px 64px 58px 1fr; gap:6px; align-items:center; min-height:26px; margin-bottom:6px;">
        <input type="checkbox" data-price-setting="ma-enabled-${i}" title="Enable MA ${i + 1}" />
        <select data-price-setting="ma-type-${i}" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
          <option value="SMA">SMA</option>
          <option value="EMA">EMA</option>
        </select>
        <input data-price-setting="ma-length-${i}" type="number" min="1" max="500" step="1" style="width:58px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;" />
        <input data-price-setting="ma-color-${i}" type="color" style="width:100%; height:24px; border:none; background:transparent; padding:0;" />
      </div>
    `).join("")}
  `;
    applyUniformSettingsPanelTypography(panel);
    panel.addEventListener("input", (event) => {
      const target = event.target;
      if (!target) return;
      const setting = target.dataset.priceSetting || "";
      if (setting === "ma-source") {
        priceChartSettings.maSourceMode = target.value === "timeframe" ? "timeframe" : "daily";
        applyMovingAverages();
        persistSettingsToStorage();
        return;
      }
      if (setting === "v-grid") {
        priceChartSettings.verticalGridlines = target.checked;
        scheduleChartLayoutRefresh();
        persistSettingsToStorage();
        return;
      }
      if (setting === "h-grid") {
        priceChartSettings.horizontalGridlines = target.checked;
        applyPriceGridOptions();
        persistSettingsToStorage();
        return;
      }
      const maMatch = setting.match(/^ma-(enabled|type|length|color)-(\d)$/);
      if (!maMatch) return;
      const key = maMatch[1];
      const index = Number(maMatch[2]);
      const ma = priceChartSettings.ma[index];
      if (!ma) return;
      if (key === "enabled") {
        ma.enabled = target.checked;
      } else if (key === "type") {
        ma.type = target.value === "EMA" ? "EMA" : "SMA";
      } else if (key === "length") {
        ma.length = Math.max(1, Math.floor(Number(target.value) || 14));
      } else if (key === "color") {
        ma.color = target.value || ma.color;
      }
      applyMovingAverages();
      persistSettingsToStorage();
    });
    panel.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      if (target.dataset.priceSetting !== "reset") return;
      event.preventDefault();
      resetPriceSettingsToDefault();
    });
    container.appendChild(panel);
    return panel;
  }
  function createRSISettingsPanel(container) {
    const panel = document.createElement("div");
    panel.className = "pane-settings-panel rsi-settings-panel";
    panel.style.position = "absolute";
    panel.style.left = "8px";
    panel.style.top = "38px";
    panel.style.zIndex = "31";
    panel.style.width = "230px";
    panel.style.maxWidth = "calc(100% - 16px)";
    panel.style.background = "rgba(22, 27, 34, 0.95)";
    panel.style.border = "1px solid #30363d";
    panel.style.borderRadius = "6px";
    panel.style.padding = "10px";
    panel.style.display = "none";
    panel.style.color = "#c9d1d9";
    panel.style.backdropFilter = "blur(6px)";
    panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">RSI</div>
      <button type="button" data-rsi-setting="reset" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Length</span>
      <input data-rsi-setting="length" type="number" min="1" max="200" step="1" style="width:64px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Line color</span>
      <input data-rsi-setting="line-color" type="color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Midline color</span>
      <input data-rsi-setting="midline-color" type="color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Midline style</span>
      <select data-rsi-setting="midline-style" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        <option value="dotted">Dotted</option>
        <option value="solid">Solid</option>
      </select>
    </label>
  `;
    applyUniformSettingsPanelTypography(panel);
    panel.addEventListener("input", (event) => {
      const target = event.target;
      if (!target) return;
      const setting = target.dataset.rsiSetting || "";
      if (setting === "length") {
        rsiSettings.length = Math.max(1, Math.floor(Number(target.value) || 14));
        applyRSISettings();
        persistSettingsToStorage();
        return;
      }
      if (setting === "line-color") {
        rsiSettings.lineColor = target.value || rsiSettings.lineColor;
        rsiChart?.setLineColor(rsiSettings.lineColor);
        persistSettingsToStorage();
        return;
      }
      if (setting === "midline-color") {
        rsiSettings.midlineColor = target.value || rsiSettings.midlineColor;
        rsiChart?.setMidlineOptions(rsiSettings.midlineColor, rsiSettings.midlineStyle);
        persistSettingsToStorage();
        return;
      }
      if (setting === "midline-style") {
        rsiSettings.midlineStyle = target.value === "solid" ? "solid" : "dotted";
        rsiChart?.setMidlineOptions(rsiSettings.midlineColor, rsiSettings.midlineStyle);
        persistSettingsToStorage();
        return;
      }
    });
    panel.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      if (target.dataset.rsiSetting !== "reset") return;
      event.preventDefault();
      resetRSISettingsToDefault();
    });
    container.appendChild(panel);
    return panel;
  }
  function createVolumeDeltaSettingsPanel(container) {
    const panel = document.createElement("div");
    panel.className = "pane-settings-panel volume-delta-settings-panel";
    panel.style.position = "absolute";
    panel.style.left = "8px";
    panel.style.top = "38px";
    panel.style.zIndex = "31";
    panel.style.width = "230px";
    panel.style.maxWidth = "calc(100% - 16px)";
    panel.style.background = "rgba(22, 27, 34, 0.95)";
    panel.style.border = "1px solid #30363d";
    panel.style.borderRadius = "6px";
    panel.style.padding = "10px";
    panel.style.display = "none";
    panel.style.color = "#c9d1d9";
    panel.style.backdropFilter = "blur(6px)";
    panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">Volume Delta</div>
      <button type="button" data-vd-setting="reset" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Source</span>
      <select data-vd-setting="source-interval" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        ${VOLUME_DELTA_SOURCE_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join("")}
      </select>
    </label>
    <label style="margin-bottom:6px;">
      <span>Divergence table</span>
      <input type="checkbox" data-vd-setting="divergence-table" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Divergent price bars</span>
      <input type="checkbox" data-vd-setting="divergent-price-bars" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Bullish</span>
      <input type="color" data-vd-setting="divergent-bullish-color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Bearish</span>
      <input type="color" data-vd-setting="divergent-bearish-color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Neutral</span>
      <input type="color" data-vd-setting="divergent-neutral-color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
  `;
    applyUniformSettingsPanelTypography(panel);
    panel.addEventListener("input", (event) => {
      const target = event.target;
      if (!target) return;
      const setting = target.dataset.vdSetting || "";
      if (setting === "source-interval") {
        const nextValue = String(target.value || "");
        if (nextValue !== "1min" && nextValue !== "5min" && nextValue !== "15min" && nextValue !== "30min" && nextValue !== "1hour" && nextValue !== "4hour") return;
        volumeDeltaSettings.sourceInterval = nextValue;
        if (currentChartTicker) {
          renderCustomChart(currentChartTicker, currentChartInterval);
        }
        persistSettingsToStorage();
        return;
      }
      if (setting === "divergence-table") {
        volumeDeltaSettings.divergenceTable = target.checked;
        if (volumeDeltaPaneContainerEl) {
          renderVolumeDeltaDivergenceSummary(volumeDeltaPaneContainerEl, currentBars);
        }
        persistSettingsToStorage();
        return;
      }
      if (setting === "divergent-price-bars") {
        volumeDeltaSettings.divergentPriceBars = target.checked;
        applyPricePaneDivergentBarColors();
        persistSettingsToStorage();
        return;
      }
      if (setting === "divergent-bullish-color") {
        volumeDeltaSettings.bullishDivergentColor = target.value || volumeDeltaSettings.bullishDivergentColor;
        applyPricePaneDivergentBarColors();
        persistSettingsToStorage();
        return;
      }
      if (setting === "divergent-bearish-color") {
        volumeDeltaSettings.bearishDivergentColor = target.value || volumeDeltaSettings.bearishDivergentColor;
        applyPricePaneDivergentBarColors();
        persistSettingsToStorage();
        return;
      }
      if (setting === "divergent-neutral-color") {
        volumeDeltaSettings.neutralDivergentColor = target.value || volumeDeltaSettings.neutralDivergentColor;
        applyPricePaneDivergentBarColors();
        persistSettingsToStorage();
        return;
      }
    });
    panel.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      if (target.dataset.vdSetting !== "reset") return;
      event.preventDefault();
      resetVolumeDeltaSettingsToDefault();
    });
    container.appendChild(panel);
    return panel;
  }
  function createVolumeDeltaRSISettingsPanel(container) {
    const panel = document.createElement("div");
    panel.className = "pane-settings-panel volume-delta-rsi-settings-panel";
    panel.style.position = "absolute";
    panel.style.left = "8px";
    panel.style.top = "38px";
    panel.style.zIndex = "31";
    panel.style.width = "230px";
    panel.style.maxWidth = "calc(100% - 16px)";
    panel.style.background = "rgba(22, 27, 34, 0.95)";
    panel.style.border = "1px solid #30363d";
    panel.style.borderRadius = "6px";
    panel.style.padding = "10px";
    panel.style.display = "none";
    panel.style.color = "#c9d1d9";
    panel.style.backdropFilter = "blur(6px)";
    panel.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; min-height:26px; margin-bottom:8px;">
      <div style="font-weight:600;">Volume Delta RSI</div>
      <button type="button" data-vd-rsi-setting="reset" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:4px 8px; font-size:12px; cursor:pointer;">Reset</button>
    </div>
    <label style="margin-bottom:6px;">
      <span>Length</span>
      <input data-vd-rsi-setting="length" type="number" min="1" max="200" step="1" style="width:64px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Source</span>
      <select data-vd-rsi-setting="source-interval" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        ${VOLUME_DELTA_SOURCE_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join("")}
      </select>
    </label>
    <label style="margin-bottom:6px;">
      <span>Line color</span>
      <input data-vd-rsi-setting="line-color" type="color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Midline color</span>
      <input data-vd-rsi-setting="midline-color" type="color" style="width:64px; height:24px; border:none; background:transparent; padding:0;" />
    </label>
    <label style="margin-bottom:6px;">
      <span>Midline style</span>
      <select data-vd-rsi-setting="midline-style" style="background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:4px; padding:2px 4px;">
        <option value="dotted">Dotted</option>
        <option value="solid">Solid</option>
      </select>
    </label>
  `;
    applyUniformSettingsPanelTypography(panel);
    panel.addEventListener("input", (event) => {
      const target = event.target;
      if (!target) return;
      const setting = target.dataset.vdRsiSetting || "";
      if (setting === "length") {
        volumeDeltaRsiSettings.length = Math.max(1, Math.floor(Number(target.value) || 14));
        applyVolumeDeltaRSISettings(true);
        persistSettingsToStorage();
        return;
      }
      if (setting === "source-interval") {
        const nextValue = String(target.value || "");
        if (nextValue !== "1min" && nextValue !== "5min" && nextValue !== "15min" && nextValue !== "30min" && nextValue !== "1hour" && nextValue !== "4hour") return;
        volumeDeltaRsiSettings.sourceInterval = nextValue;
        applyVolumeDeltaRSISettings(true);
        persistSettingsToStorage();
        return;
      }
      if (setting === "line-color") {
        volumeDeltaRsiSettings.lineColor = target.value || volumeDeltaRsiSettings.lineColor;
        applyVolumeDeltaRSISettings(false);
        persistSettingsToStorage();
        return;
      }
      if (setting === "midline-color") {
        volumeDeltaRsiSettings.midlineColor = target.value || volumeDeltaRsiSettings.midlineColor;
        applyVolumeDeltaRSISettings(false);
        persistSettingsToStorage();
        return;
      }
      if (setting === "midline-style") {
        volumeDeltaRsiSettings.midlineStyle = target.value === "solid" ? "solid" : "dotted";
        applyVolumeDeltaRSISettings(false);
        persistSettingsToStorage();
        return;
      }
    });
    panel.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      if (target.dataset.vdRsiSetting !== "reset") return;
      event.preventDefault();
      resetVolumeDeltaRSISettingsToDefault();
    });
    container.appendChild(panel);
    return panel;
  }
  function ensureSettingsUI(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer) {
    const priceBtn = createSettingsButton(chartContainer, "price");
    ensureVDFButton(chartContainer);
    const vdfRefBtn = ensureVDFRefreshButton(chartContainer);
    const volumeDeltaRsiBtn = createSettingsButton(volumeDeltaRsiContainer, "volumeDeltaRsi");
    const rsiBtn = createSettingsButton(rsiContainer, "rsi");
    const volumeDeltaBtn = createSettingsButton(volumeDeltaContainer, "volumeDelta");
    createPaneNameBadge(chartContainer, "price");
    createPaneNameBadge(volumeDeltaRsiContainer, "volumeDeltaRsi");
    createPaneNameBadge(rsiContainer, "rsi");
    createPaneNameBadge(volumeDeltaContainer, "volumeDelta");
    const volumeDeltaRsiTrendBtn = createPaneTrendlineButton(volumeDeltaRsiContainer, "volumeDeltaRsi", "trend", 0);
    const volumeDeltaRsiEraseBtn = createPaneTrendlineButton(volumeDeltaRsiContainer, "volumeDeltaRsi", "erase", 1);
    const volumeDeltaRsiDivergenceBtn = createPaneTrendlineButton(volumeDeltaRsiContainer, "volumeDeltaRsi", "divergence", 2);
    const rsiTrendBtn = createPaneTrendlineButton(rsiContainer, "rsi", "trend", 0);
    const rsiEraseBtn = createPaneTrendlineButton(rsiContainer, "rsi", "erase", 1);
    const rsiDivergenceBtn = createPaneTrendlineButton(rsiContainer, "rsi", "divergence", 2);
    if (!priceSettingsPanelEl || priceSettingsPanelEl.parentElement !== chartContainer) {
      if (priceSettingsPanelEl?.parentElement) {
        priceSettingsPanelEl.parentElement.removeChild(priceSettingsPanelEl);
      }
      priceSettingsPanelEl = createPriceSettingsPanel(chartContainer);
    }
    if (!rsiSettingsPanelEl || rsiSettingsPanelEl.parentElement !== rsiContainer) {
      if (rsiSettingsPanelEl?.parentElement) {
        rsiSettingsPanelEl.parentElement.removeChild(rsiSettingsPanelEl);
      }
      rsiSettingsPanelEl = createRSISettingsPanel(rsiContainer);
    }
    if (!volumeDeltaRsiSettingsPanelEl || volumeDeltaRsiSettingsPanelEl.parentElement !== volumeDeltaRsiContainer) {
      if (volumeDeltaRsiSettingsPanelEl?.parentElement) {
        volumeDeltaRsiSettingsPanelEl.parentElement.removeChild(volumeDeltaRsiSettingsPanelEl);
      }
      volumeDeltaRsiSettingsPanelEl = createVolumeDeltaRSISettingsPanel(volumeDeltaRsiContainer);
    }
    if (!volumeDeltaSettingsPanelEl || volumeDeltaSettingsPanelEl.parentElement !== volumeDeltaContainer) {
      if (volumeDeltaSettingsPanelEl?.parentElement) {
        volumeDeltaSettingsPanelEl.parentElement.removeChild(volumeDeltaSettingsPanelEl);
      }
      volumeDeltaSettingsPanelEl = createVolumeDeltaSettingsPanel(volumeDeltaContainer);
    }
    syncPriceSettingsPanelValues();
    syncVolumeDeltaSettingsPanelValues();
    syncVolumeDeltaRSISettingsPanelValues();
    syncRSISettingsPanelValues();
    if (!priceBtn.dataset.bound) {
      priceBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const nextDisplay = priceSettingsPanelEl?.style.display === "block" ? "none" : "block";
        hideSettingsPanels();
        if (priceSettingsPanelEl) priceSettingsPanelEl.style.display = nextDisplay;
      });
      priceBtn.dataset.bound = "1";
    }
    if (!volumeDeltaRsiBtn.dataset.bound) {
      volumeDeltaRsiBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const nextDisplay = volumeDeltaRsiSettingsPanelEl?.style.display === "block" ? "none" : "block";
        hideSettingsPanels();
        if (volumeDeltaRsiSettingsPanelEl) volumeDeltaRsiSettingsPanelEl.style.display = nextDisplay;
      });
      volumeDeltaRsiBtn.dataset.bound = "1";
    }
    if (!volumeDeltaBtn.dataset.bound) {
      volumeDeltaBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const nextDisplay = volumeDeltaSettingsPanelEl?.style.display === "block" ? "none" : "block";
        hideSettingsPanels();
        if (volumeDeltaSettingsPanelEl) volumeDeltaSettingsPanelEl.style.display = nextDisplay;
      });
      volumeDeltaBtn.dataset.bound = "1";
    }
    if (!rsiBtn.dataset.bound) {
      rsiBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const nextDisplay = rsiSettingsPanelEl?.style.display === "block" ? "none" : "block";
        hideSettingsPanels();
        if (rsiSettingsPanelEl) rsiSettingsPanelEl.style.display = nextDisplay;
      });
      rsiBtn.dataset.bound = "1";
    }
    if (!volumeDeltaRsiTrendBtn.dataset.bound) {
      volumeDeltaRsiTrendBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleVolumeDeltaRSITrendlineTool();
      });
      volumeDeltaRsiTrendBtn.dataset.bound = "1";
    }
    if (!volumeDeltaRsiEraseBtn.dataset.bound) {
      volumeDeltaRsiEraseBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearVolumeDeltaRSITrendlines();
      });
      volumeDeltaRsiEraseBtn.dataset.bound = "1";
    }
    if (!volumeDeltaRsiDivergenceBtn.dataset.bound) {
      volumeDeltaRsiDivergenceBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleVolumeDeltaRsiDivergencePlotTool();
      });
      volumeDeltaRsiDivergenceBtn.dataset.bound = "1";
    }
    if (!rsiTrendBtn.dataset.bound) {
      rsiTrendBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleRSITrendlineTool();
      });
      rsiTrendBtn.dataset.bound = "1";
    }
    if (!rsiEraseBtn.dataset.bound) {
      rsiEraseBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearRSITrendlines();
      });
      rsiEraseBtn.dataset.bound = "1";
    }
    if (!rsiDivergenceBtn.dataset.bound) {
      rsiDivergenceBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleRsiDivergencePlotTool();
      });
      rsiDivergenceBtn.dataset.bound = "1";
    }
    if (!vdfRefBtn.dataset.bound) {
      vdfRefBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (currentChartTicker) {
          renderVDFRefreshIcon(true);
          runVDFDetection(currentChartTicker, true).finally(() => {
            renderVDFRefreshIcon(false);
          });
        }
      });
      vdfRefBtn.dataset.bound = "1";
    }
    setPaneTrendlineToolActive("rsi", rsiDivergenceToolActive);
    setPaneTrendlineToolActive("volumeDeltaRsi", volumeDeltaDivergenceToolActive);
    setPaneToolButtonActive("rsi", "divergence", rsiDivergencePlotToolActive);
    setPaneToolButtonActive("volumeDeltaRsi", "divergence", volumeDeltaRsiDivergencePlotToolActive);
    if (!document.body.dataset.chartSettingsBound) {
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!target) return;
        if (target.closest(".pane-settings-panel") || target.closest(".pane-settings-btn")) return;
        hideSettingsPanels();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        deactivateInteractivePaneToolsFromEscape();
      });
      document.body.dataset.chartSettingsBound = "1";
    }
  }
  function ensurePricePaneChangeEl(container) {
    let changeEl = container.querySelector(".price-pane-change");
    if (changeEl) return changeEl;
    const startLeft = getPaneBadgeStartLeft(container);
    changeEl = document.createElement("div");
    changeEl.className = `price-pane-change ${TOP_PANE_BADGE_CLASS}`;
    changeEl.dataset.topPaneBadgeRole = "price-change";
    changeEl.style.position = "absolute";
    changeEl.style.left = `${startLeft}px`;
    changeEl.style.top = "8px";
    changeEl.style.zIndex = "30";
    changeEl.style.minHeight = "24px";
    changeEl.style.display = "inline-flex";
    changeEl.style.alignItems = "center";
    changeEl.style.padding = "0 8px";
    changeEl.style.borderRadius = "4px";
    changeEl.style.border = "1px solid #30363d";
    changeEl.style.background = "#161b22";
    changeEl.style.color = "#c9d1d9";
    changeEl.style.fontSize = "12px";
    changeEl.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
    changeEl.style.pointerEvents = "none";
    changeEl.style.display = "none";
    container.appendChild(changeEl);
    return changeEl;
  }
  function rebuildPricePaneChangeMap(bars) {
    priceChangeByTime = /* @__PURE__ */ new Map();
    if (!Array.isArray(bars) || bars.length < 2) return;
    for (let i = 1; i < bars.length; i++) {
      const currClose = Number(bars[i]?.close);
      const prevClose = Number(bars[i - 1]?.close);
      if (!Number.isFinite(currClose) || !Number.isFinite(prevClose) || prevClose === 0) continue;
      const percentChange = (currClose - prevClose) / prevClose * 100;
      priceChangeByTime.set(timeKey(bars[i].time), percentChange);
    }
  }
  function setPricePaneChange(container, time) {
    const changeEl = ensurePricePaneChangeEl(container);
    if (!currentBars.length || priceChangeByTime.size === 0) {
      changeEl.style.display = "none";
      changeEl.textContent = "";
      layoutTopPaneBadges(container);
      return;
    }
    const fallbackTime = currentBars[currentBars.length - 1]?.time;
    const targetKey = time !== null && time !== void 0 ? timeKey(time) : timeKey(fallbackTime);
    const deltaValue = Number(priceChangeByTime.get(targetKey));
    if (!Number.isFinite(deltaValue)) {
      changeEl.style.display = "none";
      changeEl.textContent = "";
      layoutTopPaneBadges(container);
      return;
    }
    const sign = deltaValue > 0 ? "+" : "";
    changeEl.textContent = `${sign}${deltaValue.toFixed(2)}%`;
    changeEl.style.color = deltaValue > 0 ? "#26a69a" : deltaValue < 0 ? "#ef5350" : "#c9d1d9";
    changeEl.style.display = "inline-flex";
    layoutTopPaneBadges(container);
  }
  function ensurePricePaneMessageEl(container) {
    let messageEl = container.querySelector(".price-pane-message");
    if (messageEl) return messageEl;
    messageEl = document.createElement("div");
    messageEl.className = "price-pane-message";
    messageEl.style.position = "absolute";
    messageEl.style.top = "50%";
    messageEl.style.left = "50%";
    messageEl.style.transform = "translate(-50%, -50%)";
    messageEl.style.color = "#8b949e";
    messageEl.style.fontSize = "1rem";
    messageEl.style.fontWeight = "600";
    messageEl.style.pointerEvents = "none";
    messageEl.style.zIndex = "20";
    messageEl.style.display = "none";
    container.appendChild(messageEl);
    return messageEl;
  }
  function setPricePaneMessage(container, message) {
    const messageEl = ensurePricePaneMessageEl(container);
    if (!message) {
      messageEl.style.display = "none";
      messageEl.textContent = "";
      return;
    }
    messageEl.textContent = message;
    messageEl.style.display = "block";
  }
  function isNoDataTickerError(err) {
    const message = String(err?.message || err || "");
    return /No .*data available for this ticker|No valid chart bars/i.test(message);
  }
  function formatPriceScaleLabel(value) {
    if (!Number.isFinite(value)) return "";
    const abs = Math.abs(value);
    let label = "";
    if (abs >= 100) {
      label = String(Math.round(value));
    } else if (abs >= 10) {
      const rounded = Math.round(value * 10) / 10;
      if (Math.abs(rounded) >= 100) {
        label = String(Math.round(rounded));
      } else {
        label = rounded.toFixed(1);
      }
    } else {
      label = (Math.round(value * 100) / 100).toFixed(2);
    }
    return label.length >= SCALE_LABEL_CHARS ? label : label.padEnd(SCALE_LABEL_CHARS, " ");
  }
  function timeKey(time) {
    return typeof time === "number" ? String(time) : time;
  }
  function fixedVolumeDeltaAutoscaleInfoProvider() {
    return {
      priceRange: {
        minValue: VOLUME_DELTA_AXIS_MIN,
        maxValue: VOLUME_DELTA_AXIS_MAX
      }
    };
  }
  function normalizeVolumeDeltaValue(value) {
    return Math.max(VOLUME_DELTA_DATA_MIN, Math.min(VOLUME_DELTA_DATA_MAX, Number(value)));
  }
  function setVolumeDeltaCursor(isCrosshair) {
    const container = document.getElementById("vd-rsi-chart-container");
    if (!container) return;
    container.style.cursor = isCrosshair ? "crosshair" : "default";
  }
  function toUnixSeconds(time) {
    return unixSecondsFromTimeValue(time);
  }
  function formatMmDdYyFromUnixSeconds(unixSeconds) {
    if (!Number.isFinite(unixSeconds)) return "N/A";
    return getAppTimeZoneFormatter("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "2-digit"
    }).format(new Date(Math.round(Number(unixSeconds)) * 1e3));
  }
  function createTrendlineCrossLabelElement(text) {
    const label = document.createElement("div");
    label.className = "trendline-cross-label";
    label.textContent = text;
    label.style.position = "absolute";
    label.style.zIndex = "29";
    label.style.minHeight = "24px";
    label.style.display = "inline-flex";
    label.style.alignItems = "center";
    label.style.padding = "0 8px";
    label.style.borderRadius = "4px";
    label.style.border = "1px solid #30363d";
    label.style.background = "#161b22";
    label.style.color = "#c9d1d9";
    label.style.fontSize = "12px";
    label.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
    label.style.pointerEvents = "none";
    label.style.whiteSpace = "nowrap";
    label.style.transform = "translate(-50%, calc(-100% - 6px))";
    return label;
  }
  function refreshVolumeDeltaTrendlineCrossLabels() {
    const container = document.getElementById("vd-rsi-chart-container");
    if (!container || !volumeDeltaRsiChart || !volumeDeltaRsiSeries) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    for (const label of volumeDeltaTrendlineCrossLabels) {
      const x2 = volumeDeltaRsiChart.timeScale().timeToCoordinate(label.anchorTime);
      const y2 = volumeDeltaRsiSeries.priceToCoordinate(label.anchorValue);
      if (!Number.isFinite(x2) || !Number.isFinite(y2) || x2 < 0 || x2 > width || y2 < 0 || y2 > height) {
        label.element.style.display = "none";
        continue;
      }
      label.element.style.display = "inline-flex";
      label.element.style.left = `${Math.round(x2)}px`;
      label.element.style.top = `${Math.round(Math.max(8, y2))}px`;
    }
  }
  function clearVolumeDeltaTrendlineCrossLabels() {
    for (const label of volumeDeltaTrendlineCrossLabels) {
      label.element.remove();
    }
    volumeDeltaTrendlineCrossLabels = [];
  }
  function addVolumeDeltaTrendlineCrossLabel(anchorTime, anchorValue, text) {
    const container = document.getElementById("vd-rsi-chart-container");
    if (!container) return;
    const element = createTrendlineCrossLabelElement(text);
    container.appendChild(element);
    volumeDeltaTrendlineCrossLabels.push({
      element,
      anchorTime,
      anchorValue
    });
    refreshVolumeDeltaTrendlineCrossLabels();
  }
  function volumeDeltaIndexToUnixSeconds(index, lastHistoricalIndex, firstHistoricalTimeSeconds, lastHistoricalTimeSeconds, stepSeconds) {
    if (!Number.isFinite(index)) return null;
    if (index > lastHistoricalIndex) {
      if (lastHistoricalTimeSeconds === null) return null;
      return lastHistoricalTimeSeconds + (index - lastHistoricalIndex) * stepSeconds;
    }
    if (index < 0) {
      if (firstHistoricalTimeSeconds === null) return null;
      return firstHistoricalTimeSeconds + index * stepSeconds;
    }
    const lowerIndex = Math.max(0, Math.floor(index));
    const upperIndex = Math.min(lastHistoricalIndex, Math.ceil(index));
    const lowerTime = toUnixSeconds(volumeDeltaRsiPoints[lowerIndex]?.time);
    const upperTime = toUnixSeconds(volumeDeltaRsiPoints[upperIndex]?.time);
    if (lowerIndex === upperIndex) return lowerTime;
    if (Number.isFinite(lowerTime) && Number.isFinite(upperTime)) {
      const ratio = index - lowerIndex;
      return Number(lowerTime) + (Number(upperTime) - Number(lowerTime)) * ratio;
    }
    if (Number.isFinite(lowerTime)) return Number(lowerTime) + (index - lowerIndex) * stepSeconds;
    if (firstHistoricalTimeSeconds === null) return null;
    return firstHistoricalTimeSeconds + index * stepSeconds;
  }
  function computeVolumeDeltaTrendlineMidlineCrossUnixSeconds(index1, value1, slope, lastHistoricalIndex, firstHistoricalTimeSeconds, lastHistoricalTimeSeconds, stepSeconds) {
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-12) return null;
    const crossIndex = index1 + (RSI_MIDLINE_VALUE - value1) / slope;
    if (!Number.isFinite(crossIndex)) return null;
    return volumeDeltaIndexToUnixSeconds(
      crossIndex,
      lastHistoricalIndex,
      firstHistoricalTimeSeconds,
      lastHistoricalTimeSeconds,
      stepSeconds
    );
  }
  function inferVolumeDeltaBarStepSeconds() {
    if (volumeDeltaRsiPoints.length < 2) return 1800;
    const diffs = [];
    for (let i = 1; i < volumeDeltaRsiPoints.length; i++) {
      const prev = toUnixSeconds(volumeDeltaRsiPoints[i - 1].time);
      const curr = toUnixSeconds(volumeDeltaRsiPoints[i].time);
      if (prev === null || curr === null) continue;
      const diff = curr - prev;
      if (Number.isFinite(diff) && diff > 0 && diff <= 8 * 3600) {
        diffs.push(diff);
      }
    }
    if (diffs.length === 0) return 1800;
    diffs.sort((a2, b2) => a2 - b2);
    return diffs[Math.floor(diffs.length / 2)];
  }
  function barsPerTradingDayFromStep(stepSeconds) {
    if (stepSeconds <= 5 * 60) return 78;
    if (stepSeconds <= 15 * 60) return 26;
    if (stepSeconds <= 30 * 60) return 13;
    if (stepSeconds <= 60 * 60) return 7;
    return 2;
  }
  function volumeDeltaFutureBarsForOneYear() {
    const stepSeconds = inferVolumeDeltaBarStepSeconds();
    return barsPerTradingDayFromStep(stepSeconds) * 252;
  }
  function clearVolumeDeltaHighlights() {
    if (!volumeDeltaHighlightSeries || !volumeDeltaRsiChart) return;
    try {
      volumeDeltaRsiChart.removeSeries(volumeDeltaHighlightSeries);
    } catch {
    }
    volumeDeltaHighlightSeries = null;
  }
  function clearVolumeDeltaTrendLines(preserveViewport = false) {
    const visibleRangeBeforeClear = preserveViewport && volumeDeltaRsiChart ? volumeDeltaRsiChart.timeScale().getVisibleLogicalRange?.() : null;
    if (preserveViewport) {
      volumeDeltaSuppressSync = true;
    }
    if (!volumeDeltaRsiChart || volumeDeltaTrendLineSeriesList.length === 0) {
      volumeDeltaTrendLineSeriesList = [];
      volumeDeltaTrendlineDefinitions = [];
      clearVolumeDeltaTrendlineCrossLabels();
      if (preserveViewport) {
        volumeDeltaSuppressSync = false;
      }
      return;
    }
    try {
      for (const series of volumeDeltaTrendLineSeriesList) {
        try {
          volumeDeltaRsiChart.removeSeries(series);
        } catch {
        }
      }
      volumeDeltaTrendLineSeriesList = [];
      volumeDeltaTrendlineDefinitions = [];
      clearVolumeDeltaTrendlineCrossLabels();
    } finally {
      if (preserveViewport && visibleRangeBeforeClear) {
        try {
          volumeDeltaRsiChart.timeScale().setVisibleLogicalRange(visibleRangeBeforeClear);
        } catch {
        }
      }
      if (preserveViewport) {
        volumeDeltaSuppressSync = false;
      }
    }
  }
  function clearVolumeDeltaDivergenceState() {
    clearVolumeDeltaHighlights();
    volumeDeltaFirstPoint = null;
    volumeDeltaDivergencePointTimeKeys.clear();
  }
  function deactivateVolumeDeltaDivergenceTool() {
    volumeDeltaDivergenceToolActive = false;
    clearVolumeDeltaDivergenceState();
    setVolumeDeltaCursor(false);
  }
  function activateVolumeDeltaDivergenceTool() {
    volumeDeltaDivergenceToolActive = true;
    setVolumeDeltaCursor(true);
  }
  function clearVolumeDeltaDivergence(preserveViewport = false) {
    clearVolumeDeltaDivergenceState();
    clearVolumeDeltaTrendLines(preserveViewport);
  }
  function highlightVolumeDeltaPoints(points) {
    clearVolumeDeltaHighlights();
    if (!volumeDeltaRsiChart || points.length === 0) return;
    volumeDeltaHighlightSeries = volumeDeltaRsiChart.addLineSeries({
      color: DIVERGENCE_HIGHLIGHT_COLOR,
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: () => fixedVolumeDeltaAutoscaleInfoProvider()
    });
    const step = Math.max(1, Math.ceil(points.length / VOLUME_DELTA_MAX_HIGHLIGHT_POINTS));
    const displayPoints = step === 1 ? points : points.filter((_2, index) => index % step === 0);
    volumeDeltaHighlightSeries.setData(displayPoints);
  }
  function drawVolumeDeltaTrendLine(time1, value1, time2, value2, recordDefinition = true) {
    if (!volumeDeltaRsiChart || !volumeDeltaRsiPoints.length) return;
    const index1 = volumeDeltaIndexByTime.get(timeKey(time1));
    const index2 = volumeDeltaIndexByTime.get(timeKey(time2));
    if (index1 === void 0 || index2 === void 0 || index1 === index2) return;
    const slope = (value2 - value1) / (index2 - index1);
    const lastHistoricalIndex = volumeDeltaRsiPoints.length - 1;
    const futureBars = volumeDeltaFutureBarsForOneYear();
    const maxIndex = lastHistoricalIndex + futureBars;
    const stepSeconds = inferVolumeDeltaBarStepSeconds();
    const firstTimeSeconds = toUnixSeconds(volumeDeltaRsiPoints[0]?.time);
    const lastTimeSeconds = toUnixSeconds(volumeDeltaRsiPoints[lastHistoricalIndex]?.time);
    const visibleRangeBeforeDraw = volumeDeltaRsiChart.timeScale().getVisibleLogicalRange?.();
    const trendLineData = [];
    volumeDeltaSuppressSync = true;
    try {
      for (let i = index1; i <= maxIndex; i++) {
        const projectedValue = value1 + slope * (i - index1);
        if (!Number.isFinite(projectedValue)) break;
        if (projectedValue < VOLUME_DELTA_DATA_MIN || projectedValue > VOLUME_DELTA_DATA_MAX) break;
        let pointTime = null;
        if (i <= lastHistoricalIndex) {
          pointTime = volumeDeltaRsiPoints[i]?.time ?? null;
        } else if (lastTimeSeconds !== null) {
          pointTime = lastTimeSeconds + (i - lastHistoricalIndex) * stepSeconds;
        }
        if (pointTime === null || pointTime === void 0) continue;
        trendLineData.push({
          time: pointTime,
          value: projectedValue
        });
      }
      if (!trendLineData.length) return;
      const trendLineSeries = volumeDeltaRsiChart.addLineSeries({
        color: TRENDLINE_COLOR,
        lineWidth: 1,
        lineStyle: 0,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => fixedVolumeDeltaAutoscaleInfoProvider()
      });
      trendLineSeries.setData(trendLineData);
      volumeDeltaTrendLineSeriesList.push(trendLineSeries);
      const crossUnixSeconds = computeVolumeDeltaTrendlineMidlineCrossUnixSeconds(
        index1,
        value1,
        slope,
        lastHistoricalIndex,
        firstTimeSeconds,
        lastTimeSeconds,
        stepSeconds
      );
      addVolumeDeltaTrendlineCrossLabel(time1, value1, formatMmDdYyFromUnixSeconds(crossUnixSeconds));
      if (recordDefinition) {
        volumeDeltaTrendlineDefinitions.push({
          time1,
          value1: Number(value1),
          time2,
          value2: Number(value2)
        });
      }
    } finally {
      if (visibleRangeBeforeDraw) {
        try {
          volumeDeltaRsiChart.timeScale().setVisibleLogicalRange(visibleRangeBeforeDraw);
        } catch {
        }
      }
      volumeDeltaSuppressSync = false;
    }
  }
  function detectAndHandleVolumeDeltaDivergenceClick(clickedTime) {
    if (!volumeDeltaDivergenceToolActive) return;
    const clickedKey = timeKey(clickedTime);
    const clickedIndex = volumeDeltaIndexByTime.get(clickedKey);
    if (clickedIndex === void 0) return;
    const clickedPoint = volumeDeltaRsiPoints[clickedIndex];
    if (!clickedPoint) return;
    const clickedRSI = Number(clickedPoint.value);
    const clickedPrice = priceByTime.get(clickedKey);
    if (!Number.isFinite(clickedRSI) || !Number.isFinite(clickedPrice)) return;
    const clickedPriceValue = Number(clickedPrice);
    if (!volumeDeltaFirstPoint) {
      volumeDeltaFirstPoint = {
        time: clickedTime,
        rsi: clickedRSI,
        price: clickedPriceValue,
        index: clickedIndex
      };
      const divergencePoints = [];
      volumeDeltaDivergencePointTimeKeys.clear();
      for (let i = clickedIndex + 1; i < volumeDeltaRsiPoints.length; i++) {
        const currentPoint = volumeDeltaRsiPoints[i];
        const currentRSI = Number(currentPoint?.value);
        if (!Number.isFinite(currentRSI)) continue;
        const currentPrice = priceByTime.get(timeKey(currentPoint.time));
        if (!Number.isFinite(currentPrice)) continue;
        const currentPriceValue = Number(currentPrice);
        const bearishDivergence = currentRSI < clickedRSI && currentPriceValue > clickedPriceValue;
        const bullishDivergence = currentRSI > clickedRSI && currentPriceValue < clickedPriceValue;
        if (!bearishDivergence && !bullishDivergence) continue;
        divergencePoints.push({ time: currentPoint.time, value: currentRSI });
        volumeDeltaDivergencePointTimeKeys.add(timeKey(currentPoint.time));
      }
      highlightVolumeDeltaPoints(divergencePoints);
      return;
    }
    if (!volumeDeltaDivergencePointTimeKeys.has(clickedKey)) {
      return;
    }
    drawVolumeDeltaTrendLine(
      volumeDeltaFirstPoint.time,
      volumeDeltaFirstPoint.rsi,
      clickedTime,
      clickedRSI
    );
    deactivateVolumeDeltaDivergenceTool();
    setPaneTrendlineToolActive("volumeDeltaRsi", false);
    persistTrendlinesForCurrentContext();
  }
  function sameLogicalRange(a2, b2) {
    if (!a2 || !b2) return false;
    return Math.abs(Number(a2.from) - Number(b2.from)) < 1e-6 && Math.abs(Number(a2.to) - Number(b2.to)) < 1e-6;
  }
  function createPriceChart(container) {
    const chart = Ve(container, {
      layout: {
        background: { color: "#0d1117" },
        textColor: "#d1d4dc",
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
        attributionLogo: false
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false }
      },
      crosshair: {
        mode: isMobileTouch ? at.Magnet : at.Normal
      },
      kineticScroll: {
        touch: false,
        mouse: false
      },
      handleScroll: {
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: isMobileTouch,
        mouseWheel: true
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
        axisDoubleClickReset: true
      },
      rightPriceScale: {
        borderColor: "#2b2b43",
        minimumWidth: SCALE_MIN_WIDTH_PX,
        entireTextOnly: true
      },
      timeScale: {
        visible: false,
        timeVisible: true,
        secondsVisible: false,
        borderVisible: false,
        fixRightEdge: false,
        rightBarStaysOnScroll: false,
        rightOffset: RIGHT_MARGIN_BARS,
        tickMarkFormatter: formatTimeScaleTickMark
      }
    });
    const series = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      priceFormat: {
        type: "custom",
        minMove: 0.01,
        formatter: (price) => formatPriceScaleLabel(Number(price))
      }
    });
    const timelineSeries = chart.addLineSeries({
      color: "rgba(0, 0, 0, 0)",
      lineVisible: false,
      pointMarkersVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });
    return { chart, series, timelineSeries };
  }
  function createVolumeDeltaRsiChart(container) {
    const chart = Ve(container, {
      layout: {
        background: { color: "#0d1117" },
        textColor: "#c9d1d9",
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
        attributionLogo: false
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false }
      },
      crosshair: {
        mode: isMobileTouch ? at.Magnet : at.Normal
      },
      kineticScroll: {
        touch: false,
        mouse: false
      },
      handleScroll: {
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: isMobileTouch,
        mouseWheel: true
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: false
        },
        axisDoubleClickReset: {
          time: true,
          price: false
        }
      },
      rightPriceScale: {
        borderColor: "#21262d",
        minimumWidth: SCALE_MIN_WIDTH_PX,
        entireTextOnly: true,
        // Default view: 20-80 range (20% margin top + 20% margin bottom)
        // User can adjust but won't go beyond 0-100 data bounds
        scaleMargins: {
          top: 0.2,
          // 20% margin = hides 0-20 by default
          bottom: 0.2
          // 20% margin = hides 80-100 by default
        }
      },
      timeScale: {
        visible: false,
        timeVisible: true,
        secondsVisible: false,
        borderVisible: false,
        fixRightEdge: false,
        rightBarStaysOnScroll: false,
        rightOffset: RIGHT_MARGIN_BARS,
        tickMarkFormatter: formatTimeScaleTickMark
      }
    });
    const rsiSeries = chart.addLineSeries({
      color: volumeDeltaRsiSettings.lineColor,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: {
        type: "custom",
        minMove: 0.1,
        formatter: (value) => formatVolumeDeltaScaleLabel(Number(value))
      },
      autoscaleInfoProvider: () => fixedVolumeDeltaAutoscaleInfoProvider()
    });
    const timelineSeries = chart.addLineSeries({
      color: "rgba(0, 0, 0, 0)",
      lineVisible: false,
      pointMarkersVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });
    volumeDeltaRsiMidlineLine = rsiSeries.createPriceLine({
      price: VOLUME_DELTA_MIDLINE,
      color: volumeDeltaRsiSettings.midlineColor,
      lineWidth: 1,
      lineStyle: midlineStyleToLineStyle(volumeDeltaRsiSettings.midlineStyle),
      axisLabelVisible: false,
      title: "Midline"
    });
    chart.subscribeClick((param) => {
      if (!param || !param.time) return;
      if (volumeDeltaRsiDivergencePlotToolActive) {
        updateVolumeDeltaRsiDivergencePlotPoint(param.time, false);
        return;
      }
      if (!volumeDeltaDivergenceToolActive) return;
      detectAndHandleVolumeDeltaDivergenceClick(param.time);
    });
    return { chart, rsiSeries, timelineSeries };
  }
  function createVolumeDeltaChart(container) {
    const chart = Ve(container, {
      layout: {
        background: { color: "#0d1117" },
        textColor: "#c9d1d9",
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
        attributionLogo: false
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false }
      },
      crosshair: {
        mode: isMobileTouch ? at.Magnet : at.Normal
      },
      kineticScroll: {
        touch: false,
        mouse: false
      },
      handleScroll: {
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: isMobileTouch,
        mouseWheel: true
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: true
        },
        axisDoubleClickReset: {
          time: true,
          price: true
        }
      },
      rightPriceScale: {
        borderColor: "#21262d",
        minimumWidth: SCALE_MIN_WIDTH_PX,
        entireTextOnly: true
      },
      timeScale: {
        visible: false,
        timeVisible: true,
        secondsVisible: false,
        borderVisible: false,
        fixRightEdge: false,
        rightBarStaysOnScroll: false,
        rightOffset: RIGHT_MARGIN_BARS,
        tickMarkFormatter: formatTimeScaleTickMark
      }
    });
    const histogramSeries = chart.addHistogramSeries({
      base: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: "custom",
        minMove: 1,
        formatter: (value) => formatVolumeDeltaHistogramScaleLabel(Number(value))
      }
    });
    const timelineSeries = chart.addLineSeries({
      color: "rgba(0, 0, 0, 0)",
      lineVisible: false,
      pointMarkersVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });
    histogramSeries.createPriceLine({
      price: 0,
      color: "#8b949e",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: false,
      title: ""
    });
    volumeDeltaChart = chart;
    return { chart, histogramSeries, timelineSeries };
  }
  function setVolumeDeltaRsiData(bars, volumeDeltaRsi) {
    if (!volumeDeltaRsiSeries) return;
    clearVolumeDeltaDivergence();
    const normalizedRsi = normalizeValueSeries(volumeDeltaRsi?.rsi || []);
    volumeDeltaRsiPoints = normalizedRsi.map((point) => ({
      time: point.time,
      value: normalizeVolumeDeltaValue(Number(point.value))
    }));
    volumeDeltaIndexByTime = /* @__PURE__ */ new Map();
    for (let i = 0; i < volumeDeltaRsiPoints.length; i++) {
      volumeDeltaIndexByTime.set(timeKey(volumeDeltaRsiPoints[i].time), i);
    }
    const rsiByTimeLocal = /* @__PURE__ */ new Map();
    for (const point of volumeDeltaRsiPoints) {
      rsiByTimeLocal.set(timeKey(point.time), Number(point.value));
    }
    const seriesData = bars.map((bar) => {
      const value = rsiByTimeLocal.get(timeKey(bar.time));
      if (!Number.isFinite(value)) return { time: bar.time };
      return { time: bar.time, value: Number(value) };
    });
    volumeDeltaRsiSeries.setData(seriesData);
    volumeDeltaRsiByTime = /* @__PURE__ */ new Map();
    for (const bar of bars) {
      const key = timeKey(bar.time);
      const rsiValue = rsiByTimeLocal.get(key);
      if (Number.isFinite(rsiValue)) {
        volumeDeltaRsiByTime.set(key, Number(rsiValue));
      }
    }
    refreshActiveDivergenceOverlays();
  }
  function restoreVolumeDeltaPersistedTrendlines(trendlines) {
    clearVolumeDeltaTrendLines();
    if (!Array.isArray(trendlines) || trendlines.length === 0) return;
    for (const line of trendlines) {
      const time1 = line?.time1;
      const time2 = line?.time2;
      const value1 = Number(line?.value1);
      const value2 = Number(line?.value2);
      if (typeof time1 !== "string" && typeof time1 !== "number" || typeof time2 !== "string" && typeof time2 !== "number") continue;
      if (!Number.isFinite(value1) || !Number.isFinite(value2)) continue;
      drawVolumeDeltaTrendLine(time1, value1, time2, value2, true);
    }
  }
  function restorePersistedTrendlinesForCurrentContext() {
    if (!currentChartTicker) return;
    const persisted = loadPersistedTrendlinesForContext(currentChartTicker, currentChartInterval);
    rsiChart?.restorePersistedTrendlines(persisted.rsi);
    restoreVolumeDeltaPersistedTrendlines(persisted.volumeDeltaRsi);
  }
  function setVolumeDeltaHistogramData(bars, volumeDeltaValues) {
    if (!volumeDeltaHistogramSeries) return;
    const deltaByTime = /* @__PURE__ */ new Map();
    for (const point of volumeDeltaValues) {
      const delta = Number(point.delta);
      if (!Number.isFinite(delta)) continue;
      deltaByTime.set(timeKey(point.time), delta);
    }
    const histogramData = bars.map((bar) => {
      const delta = deltaByTime.get(timeKey(bar.time)) ?? 0;
      const numeric = Number.isFinite(Number(delta)) ? Number(delta) : 0;
      return {
        time: bar.time,
        value: numeric,
        color: numeric >= 0 ? VOLUME_DELTA_POSITIVE_COLOR : VOLUME_DELTA_NEGATIVE_COLOR
      };
    });
    volumeDeltaHistogramSeries.setData(histogramData);
    volumeDeltaByTime = new Map(
      histogramData.map((point) => [timeKey(point.time), Number(point.value) || 0])
    );
    applyPricePaneDivergentBarColors();
  }
  function ensureVolumeDeltaDivergenceSummaryEl(container) {
    if (volumeDeltaDivergenceSummaryEl && volumeDeltaDivergenceSummaryEl.parentElement === container) {
      volumeDeltaDivergenceSummaryEl.style.top = "8px";
      volumeDeltaDivergenceSummaryEl.style.transform = "none";
      volumeDeltaDivergenceSummaryEl.style.right = `${SCALE_MIN_WIDTH_PX + 8}px`;
      volumeDeltaDivergenceSummaryEl.style.display = "flex";
      volumeDeltaDivergenceSummaryEl.style.flexDirection = "row";
      volumeDeltaDivergenceSummaryEl.style.alignItems = "center";
      volumeDeltaDivergenceSummaryEl.style.gap = `${PANE_TOOL_BUTTON_GAP_PX}px`;
      volumeDeltaDivergenceSummaryEl.style.background = "transparent";
      volumeDeltaDivergenceSummaryEl.style.border = "none";
      volumeDeltaDivergenceSummaryEl.style.borderRadius = "0";
      volumeDeltaDivergenceSummaryEl.style.overflow = "visible";
      return volumeDeltaDivergenceSummaryEl;
    }
    const el = document.createElement("div");
    el.className = "volume-delta-divergence-summary";
    el.style.position = "absolute";
    el.style.top = "8px";
    el.style.transform = "none";
    el.style.right = `${SCALE_MIN_WIDTH_PX + 8}px`;
    el.style.zIndex = "34";
    el.style.display = "flex";
    el.style.flexDirection = "row";
    el.style.alignItems = "center";
    el.style.gap = `${PANE_TOOL_BUTTON_GAP_PX}px`;
    el.style.background = "transparent";
    el.style.border = "none";
    el.style.borderRadius = "0";
    el.style.overflow = "visible";
    el.style.pointerEvents = "auto";
    container.appendChild(el);
    volumeDeltaDivergenceSummaryEl = el;
    return el;
  }
  function clearVolumeDeltaDivergenceSummary() {
    if (!volumeDeltaDivergenceSummaryEl) return;
    volumeDeltaDivergenceSummaryEl.style.display = "none";
    volumeDeltaDivergenceSummaryEl.innerHTML = "";
  }
  function renderVolumeDeltaDivergenceSummary(container, bars, options) {
    if (!volumeDeltaSettings.divergenceTable) {
      clearVolumeDeltaDivergenceSummary();
      return;
    }
    const summaryEl = ensureVolumeDeltaDivergenceSummaryEl(container);
    summaryEl.innerHTML = "";
    summaryEl.style.display = "flex";
    summaryEl.style.flexDirection = "row";
    summaryEl.style.alignItems = "center";
    const ticker = String(currentChartTicker || "").trim().toUpperCase();
    const sourceInterval = volumeDeltaSettings.sourceInterval;
    const noCache = options?.noCache === true;
    const requestToken = `${ticker}|${sourceInterval}|${Date.now()}`;
    summaryEl.dataset.requestToken = requestToken;
    let manualRefreshInFlight = false;
    let lastSummary = null;
    const buildBadge = (text, color, title) => {
      const badge = document.createElement("div");
      badge.textContent = text;
      badge.title = title;
      badge.style.display = "inline-flex";
      badge.style.alignItems = "center";
      badge.style.justifyContent = "center";
      badge.style.width = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
      badge.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
      badge.style.padding = "0";
      badge.style.borderRadius = "4px";
      badge.style.border = "1px solid #30363d";
      badge.style.background = "#161b22";
      badge.style.fontSize = "12px";
      badge.style.fontWeight = "600";
      badge.style.lineHeight = "1";
      badge.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
      badge.style.color = color;
      badge.style.pointerEvents = "none";
      return badge;
    };
    const runManualRefresh = () => {
      if (manualRefreshInFlight) return;
      manualRefreshInFlight = true;
      renderSummary(lastSummary, true);
      getTickerDivergenceSummary(
        ticker,
        sourceInterval,
        { forceRefresh: true, noCache: true }
      ).then((summary) => {
        if (summaryEl.dataset.requestToken !== requestToken) return;
        if (String(currentChartTicker || "").trim().toUpperCase() !== ticker) return;
        lastSummary = summary || null;
        renderSummary(lastSummary, false);
      }).catch(() => {
        if (summaryEl.dataset.requestToken !== requestToken) return;
        if (String(currentChartTicker || "").trim().toUpperCase() !== ticker) return;
        renderSummary(lastSummary, false);
      }).finally(() => {
        manualRefreshInFlight = false;
      });
    };
    const renderSummary = (summary, loading = false) => {
      if (summaryEl.dataset.requestToken !== requestToken) return;
      if (String(currentChartTicker || "").trim().toUpperCase() !== ticker) return;
      summaryEl.innerHTML = "";
      const refreshButton = document.createElement("button");
      refreshButton.type = "button";
      refreshButton.title = loading ? "Refreshing divergence table..." : "Refresh divergence table";
      refreshButton.style.display = "inline-flex";
      refreshButton.style.alignItems = "center";
      refreshButton.style.justifyContent = "center";
      refreshButton.style.width = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
      refreshButton.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
      refreshButton.style.padding = "0";
      refreshButton.style.borderRadius = "4px";
      refreshButton.style.border = "none";
      refreshButton.style.background = "transparent";
      refreshButton.style.color = "#c9d1d9";
      refreshButton.style.cursor = loading ? "wait" : "pointer";
      refreshButton.style.pointerEvents = loading ? "none" : "auto";
      refreshButton.style.userSelect = "none";
      refreshButton.style.flex = "0 0 auto";
      refreshButton.style.verticalAlign = "middle";
      refreshButton.setAttribute("aria-disabled", loading ? "true" : "false");
      refreshButton.disabled = false;
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("width", "11");
      svg.setAttribute("height", "11");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2.5");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.style.display = "block";
      const path1 = document.createElementNS(svgNS, "path");
      path1.setAttribute("d", "M21.5 2v6h-6");
      const path2 = document.createElementNS(svgNS, "path");
      path2.setAttribute("d", "M21.5 8A10 10 0 0 0 5.6 5.6");
      const path3 = document.createElementNS(svgNS, "path");
      path3.setAttribute("d", "M2.5 22v-6h6");
      const path4 = document.createElementNS(svgNS, "path");
      path4.setAttribute("d", "M2.5 16A10 10 0 0 0 18.4 18.4");
      svg.appendChild(path1);
      svg.appendChild(path2);
      svg.appendChild(path3);
      svg.appendChild(path4);
      if (loading) {
        svg.animate(
          [
            { transform: "rotate(0deg)" },
            { transform: "rotate(360deg)" }
          ],
          {
            duration: 800,
            iterations: Infinity,
            easing: "linear"
          }
        );
      }
      refreshButton.appendChild(svg);
      refreshButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        runManualRefresh();
      });
      summaryEl.appendChild(refreshButton);
      for (let i = 0; i < DIVERGENCE_LOOKBACK_DAYS.length; i++) {
        const days = DIVERGENCE_LOOKBACK_DAYS[i];
        const state = summary?.states?.[String(days)] || "neutral";
        const badgeColor = state === "bullish" ? "#26a69a" : state === "bearish" ? "#ef5350" : "#ffffff";
        const badge = buildBadge(
          String(days),
          badgeColor,
          `Last ${days} day${days === 1 ? "" : "s"}${summary?.tradeDate ? ` (as of ${summary.tradeDate})` : ""}`
        );
        summaryEl.appendChild(badge);
      }
    };
    renderSummary(null, false);
    if (!ticker || (!Array.isArray(bars) || bars.length < 2)) {
      return;
    }
    getTickerDivergenceSummary(ticker, sourceInterval).then((summary) => {
      if (summaryEl.dataset.requestToken !== requestToken) return;
      lastSummary = summary || null;
      renderSummary(lastSummary, false);
      const needsRefresh = noCache || !summary || !Number.isFinite(summary.expiresAtMs) || summary.expiresAtMs <= Date.now();
      if (needsRefresh) {
        getTickerDivergenceSummary(
          ticker,
          sourceInterval,
          { forceRefresh: true, noCache: true }
        ).then((freshSummary) => {
          if (summaryEl.dataset.requestToken !== requestToken) return;
          lastSummary = freshSummary || null;
          renderSummary(lastSummary, false);
        }).catch(() => {
        });
      }
    }).catch(() => {
      getTickerDivergenceSummary(
        ticker,
        sourceInterval,
        { forceRefresh: true, noCache: true }
      ).then((summary) => {
        if (summaryEl.dataset.requestToken !== requestToken) return;
        lastSummary = summary || null;
        renderSummary(lastSummary, false);
      }).catch(() => {
        renderSummary(lastSummary, false);
      });
    });
  }
  var VDF_COLOR_LOADING = "#c9d1d9";
  var VDF_COLOR_NOT_DETECTED = "#484f58";
  var VDF_COLOR_ERROR = "#ef5350";
  function ensureVDFButton(container) {
    if (vdfButtonEl && vdfButtonEl.parentElement === container) return vdfButtonEl;
    if (vdfButtonEl && vdfButtonEl.parentElement) {
      vdfButtonEl.parentElement.removeChild(vdfButtonEl);
    }
    const btn = document.createElement("button");
    btn.className = "vdf-indicator-btn";
    btn.type = "button";
    btn.title = "Volume Divergence Flag Detector";
    btn.textContent = "VDF";
    btn.style.position = "absolute";
    btn.style.top = `${PANE_TOOL_BUTTON_TOP_PX}px`;
    btn.style.right = `${SCALE_MIN_WIDTH_PX + 8}px`;
    btn.style.zIndex = "34";
    btn.style.width = "auto";
    btn.style.minWidth = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    btn.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    btn.style.padding = "0 5px";
    btn.style.borderRadius = "4px";
    btn.style.border = "1px solid #30363d";
    btn.style.background = "#161b22";
    btn.style.color = VDF_COLOR_LOADING;
    btn.style.cursor = "default";
    btn.style.pointerEvents = "none";
    btn.style.fontSize = "9px";
    btn.style.fontWeight = "700";
    btn.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
    btn.style.letterSpacing = "0.5px";
    btn.style.lineHeight = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    btn.style.textAlign = "center";
    btn.style.userSelect = "none";
    container.appendChild(btn);
    vdfButtonEl = btn;
    return btn;
  }
  function ensureVDFRefreshButton(container) {
    if (vdfRefreshButtonEl && vdfRefreshButtonEl.parentElement === container) return vdfRefreshButtonEl;
    if (vdfRefreshButtonEl && vdfRefreshButtonEl.parentElement) {
      vdfRefreshButtonEl.parentElement.removeChild(vdfRefreshButtonEl);
    }
    const btn = document.createElement("button");
    btn.className = "vdf-refresh-btn";
    btn.type = "button";
    btn.title = "Refresh VD Analysis";
    btn.style.position = "absolute";
    btn.style.top = `${PANE_TOOL_BUTTON_TOP_PX}px`;
    btn.style.right = `${SCALE_MIN_WIDTH_PX + 8 + 36 + PANE_TOOL_BUTTON_GAP_PX}px`;
    btn.style.zIndex = "34";
    btn.style.display = "inline-flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.width = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    btn.style.height = `${PANE_TOOL_BUTTON_SIZE_PX}px`;
    btn.style.padding = "0";
    btn.style.borderRadius = "4px";
    btn.style.border = "none";
    btn.style.background = "transparent";
    btn.style.color = "#c9d1d9";
    btn.style.cursor = "pointer";
    btn.style.userSelect = "none";
    container.appendChild(btn);
    vdfRefreshButtonEl = btn;
    renderVDFRefreshIcon(false);
    return btn;
  }
  function renderVDFRefreshIcon(loading) {
    if (!vdfRefreshButtonEl) return;
    vdfRefreshButtonEl.innerHTML = "";
    vdfRefreshButtonEl.title = loading ? "Refreshing VD Analysis..." : "Refresh VD Analysis";
    vdfRefreshButtonEl.style.cursor = loading ? "wait" : "pointer";
    vdfRefreshButtonEl.style.pointerEvents = loading ? "none" : "auto";
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", "11");
    svg.setAttribute("height", "11");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.display = "block";
    const path1 = document.createElementNS(svgNS, "path");
    path1.setAttribute("d", "M21.5 2v6h-6");
    const path2 = document.createElementNS(svgNS, "path");
    path2.setAttribute("d", "M21.5 8A10 10 0 0 0 5.6 5.6");
    const path3 = document.createElementNS(svgNS, "path");
    path3.setAttribute("d", "M2.5 22v-6h6");
    const path4 = document.createElementNS(svgNS, "path");
    path4.setAttribute("d", "M2.5 16A10 10 0 0 0 18.4 18.4");
    svg.appendChild(path1);
    svg.appendChild(path2);
    svg.appendChild(path3);
    svg.appendChild(path4);
    if (loading) {
      svg.animate(
        [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
        { duration: 800, iterations: Infinity, easing: "linear" }
      );
    }
    vdfRefreshButtonEl.appendChild(svg);
  }
  function setVDFButtonColor(color, title) {
    if (!vdfButtonEl) return;
    vdfButtonEl.style.color = color;
    if (title !== void 0) vdfButtonEl.title = title;
  }
  function buildVDFTooltip(entry) {
    if (!entry.is_detected) return `VD Accumulation: Not detected`;
    const score = Math.round(entry.composite_score * 100);
    let tip = `VD Accumulation Score: ${score}`;
    const bestZone = entry.zones?.[0];
    if (bestZone) {
      const startParts = bestZone.startDate.split("-");
      const endParts = bestZone.endDate.split("-");
      const startLabel = startParts.length >= 3 ? `${Number(startParts[1])}/${Number(startParts[2])}` : bestZone.startDate;
      const endLabel = endParts.length >= 3 ? `${Number(endParts[1])}/${Number(endParts[2])}` : bestZone.endDate;
      tip += `
Zone: ${startLabel}\u2192${endLabel} (${bestZone.windowDays}d)`;
      if (bestZone.absorptionPct != null) tip += `
Absorption: ${(bestZone.absorptionPct * 100).toFixed(1)}%`;
    }
    if (entry.zones?.length > 1) tip += `
+${entry.zones.length - 1} more zone(s)`;
    if (entry.distribution?.length > 0) tip += `
Distribution: ${entry.distribution.length} cluster(s)`;
    const prox = entry.proximity;
    if (prox && prox.level !== "none") {
      tip += `
Proximity: ${prox.level.charAt(0).toUpperCase() + prox.level.slice(1)} (${prox.compositeScore} pts)`;
      for (const sig of prox.signals) {
        tip += `
  \u2713 ${sig.detail} +${sig.points}`;
      }
    }
    return tip;
  }
  function updateVDFButton(entry) {
    if (!vdfButtonEl) return;
    if (entry.is_detected) {
      const score = Math.round(entry.composite_score * 100);
      vdfButtonEl.textContent = String(score);
      vdfButtonEl.style.color = score >= 80 ? "#26a69a" : score >= 60 ? "#8bc34a" : "#c9d1d9";
      const proxLevel = entry.proximity?.level || "none";
      if (proxLevel === "imminent" || proxLevel === "high") {
        vdfButtonEl.style.borderColor = "#ff9800";
      } else if (proxLevel === "elevated") {
        vdfButtonEl.style.borderColor = "#ffc107";
      } else {
        vdfButtonEl.style.borderColor = "#30363d";
      }
    } else {
      vdfButtonEl.textContent = "VDF";
      vdfButtonEl.style.color = VDF_COLOR_NOT_DETECTED;
      vdfButtonEl.style.borderColor = "#30363d";
    }
    vdfButtonEl.title = buildVDFTooltip(entry);
  }
  function ensureVDZoneOverlay(container) {
    if (vdZoneOverlayEl && vdZoneOverlayEl.parentElement === container) return vdZoneOverlayEl;
    if (vdZoneOverlayEl?.parentElement) vdZoneOverlayEl.parentElement.removeChild(vdZoneOverlayEl);
    const overlay = document.createElement("div");
    overlay.className = "vd-zone-overlay";
    overlay.style.position = "absolute";
    overlay.style.top = "0";
    overlay.style.right = "0";
    overlay.style.bottom = "0";
    overlay.style.left = "0";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "5";
    container.appendChild(overlay);
    vdZoneOverlayEl = overlay;
    return overlay;
  }
  function renderVDZones(entry) {
    if (!vdZoneOverlayEl) return;
    vdZoneOverlayEl.innerHTML = "";
    if (!priceChart || !entry) return;
    const overlayWidth = vdZoneOverlayEl.clientWidth || vdZoneOverlayEl.offsetWidth;
    const overlayHeight = vdZoneOverlayEl.clientHeight || vdZoneOverlayEl.offsetHeight;
    if (!Number.isFinite(overlayWidth) || overlayWidth <= 0) return;
    const dateToBarTime = /* @__PURE__ */ new Map();
    for (const bar of currentBars) {
      const t = unixSecondsFromTimeValue(bar?.time);
      if (t === null) continue;
      const dateKey = new Date(t * 1e3).toLocaleDateString("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
      if (!dateToBarTime.has(dateKey)) dateToBarTime.set(dateKey, t);
    }
    const dateToX = (dateStr) => {
      const barTime = dateToBarTime.get(dateStr);
      if (barTime === void 0) return null;
      const x2 = priceChart.timeScale().timeToCoordinate(barTime);
      return Number.isFinite(x2) ? x2 : null;
    };
    const overlayZones = entry.allZones && entry.allZones.length > 0 ? entry.allZones : entry.zones;
    if (overlayZones) {
      for (const zone of overlayZones) {
        const x1 = dateToX(zone.startDate);
        const x2 = dateToX(zone.endDate);
        if (x1 == null || x2 == null) continue;
        const left = Math.min(x1, x2);
        const width = Math.abs(x2 - x1);
        if (left > overlayWidth || left + width < 0) continue;
        const opacity = 0.04 + zone.score * 0.08;
        const rect = document.createElement("div");
        rect.style.cssText = `position:absolute;left:${Math.round(left)}px;top:0;width:${Math.max(Math.round(width), 2)}px;height:100%;background:rgba(38,166,154,${opacity.toFixed(3)});border-left:1px solid rgba(38,166,154,0.3);border-right:1px solid rgba(38,166,154,0.3);`;
        const badge = document.createElement("div");
        badge.style.cssText = "position:absolute;top:2px;right:2px;font-size:9px;color:rgba(38,166,154,0.8);font-family:monospace;";
        badge.textContent = (zone.score * 100).toFixed(0);
        rect.appendChild(badge);
        vdZoneOverlayEl.appendChild(rect);
      }
    }
    if (entry.distribution) {
      for (const dist of entry.distribution) {
        const x1 = dateToX(dist.startDate);
        const x2 = dateToX(dist.endDate);
        if (x1 == null || x2 == null) continue;
        const left = Math.min(x1, x2);
        const width = Math.abs(x2 - x1);
        if (left > overlayWidth || left + width < 0) continue;
        const rect = document.createElement("div");
        rect.style.cssText = `position:absolute;left:${Math.round(left)}px;top:0;width:${Math.max(Math.round(width), 2)}px;height:100%;background:rgba(239,83,80,0.06);border-left:1px solid rgba(239,83,80,0.3);border-right:1px solid rgba(239,83,80,0.3);`;
        vdZoneOverlayEl.appendChild(rect);
      }
    }
    const BAND_H = 5;
    const BAND_GAP = 1;
    const STRIP_PAD = 2;
    const hasZones = overlayZones && overlayZones.length > 0;
    const hasDist = entry.distribution && entry.distribution.length > 0;
    if (overlayHeight > 60 && (hasZones || hasDist)) {
      const absY = overlayHeight - STRIP_PAD - BAND_H;
      const distY = absY - BAND_GAP - BAND_H;
      const accumY = distY - BAND_GAP - BAND_H;
      if (overlayZones) {
        for (const zone of overlayZones) {
          const x1 = dateToX(zone.startDate);
          const x2 = dateToX(zone.endDate);
          if (x1 == null || x2 == null) continue;
          const left = Math.min(x1, x2);
          const width = Math.abs(x2 - x1);
          if (left > overlayWidth || left + width < 0) continue;
          const op = (0.4 + zone.score * 0.5).toFixed(2);
          const band = document.createElement("div");
          band.style.cssText = `position:absolute;left:${Math.round(left)}px;top:${accumY}px;width:${Math.max(Math.round(width), 2)}px;height:${BAND_H}px;background:rgba(38,166,154,${op});border-radius:1px;`;
          vdZoneOverlayEl.appendChild(band);
        }
      }
      if (entry.distribution) {
        for (const dist of entry.distribution) {
          const x1 = dateToX(dist.startDate);
          const x2 = dateToX(dist.endDate);
          if (x1 == null || x2 == null) continue;
          const left = Math.min(x1, x2);
          const width = Math.abs(x2 - x1);
          if (left > overlayWidth || left + width < 0) continue;
          const band = document.createElement("div");
          band.style.cssText = `position:absolute;left:${Math.round(left)}px;top:${distY}px;width:${Math.max(Math.round(width), 2)}px;height:${BAND_H}px;background:rgba(239,83,80,0.65);border-radius:1px;`;
          vdZoneOverlayEl.appendChild(band);
        }
      }
      if (overlayZones) {
        for (const zone of overlayZones) {
          const absPct = zone.absorptionPct || 0;
          if (absPct < 5) continue;
          const x1 = dateToX(zone.startDate);
          const x2 = dateToX(zone.endDate);
          if (x1 == null || x2 == null) continue;
          const left = Math.min(x1, x2);
          const width = Math.abs(x2 - x1);
          if (left > overlayWidth || left + width < 0) continue;
          const op = Math.min(0.3 + absPct / 100 * 0.6, 0.9).toFixed(2);
          const band = document.createElement("div");
          band.style.cssText = `position:absolute;left:${Math.round(left)}px;top:${absY}px;width:${Math.max(Math.round(width), 2)}px;height:${BAND_H}px;background:rgba(255,167,38,${op});border-radius:1px;`;
          vdZoneOverlayEl.appendChild(band);
        }
      }
    }
    if (overlayZones) {
      for (const zone of overlayZones) {
        const xs2 = dateToX(zone.startDate);
        const xe2 = dateToX(zone.endDate);
        if (xs2 != null && xs2 >= 0 && xs2 <= overlayWidth) {
          const line = document.createElement("div");
          line.style.cssText = `position:absolute;left:${Math.round(xs2)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(38,166,154,0.25);`;
          vdZoneOverlayEl.appendChild(line);
        }
        if (xe2 != null && xe2 >= 0 && xe2 <= overlayWidth) {
          const line = document.createElement("div");
          line.style.cssText = `position:absolute;left:${Math.round(xe2)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(38,166,154,0.25);`;
          vdZoneOverlayEl.appendChild(line);
        }
      }
    }
    if (entry.distribution) {
      for (const dist of entry.distribution) {
        const xs2 = dateToX(dist.startDate);
        const xe2 = dateToX(dist.endDate);
        if (xs2 != null && xs2 >= 0 && xs2 <= overlayWidth) {
          const line = document.createElement("div");
          line.style.cssText = `position:absolute;left:${Math.round(xs2)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(239,83,80,0.2);`;
          vdZoneOverlayEl.appendChild(line);
        }
        if (xe2 != null && xe2 >= 0 && xe2 <= overlayWidth) {
          const line = document.createElement("div");
          line.style.cssText = `position:absolute;left:${Math.round(xe2)}px;top:0;width:0;height:100%;border-left:1px dashed rgba(239,83,80,0.2);`;
          vdZoneOverlayEl.appendChild(line);
        }
      }
    }
    const prox = entry.proximity;
    if (prox && prox.level !== "none" && prox.compositeScore > 0) {
      const proxRgb = prox.level === "imminent" ? "244,67,54" : prox.level === "high" ? "255,152,0" : "255,193,7";
      const proxOp = prox.level === "imminent" ? 0.4 : prox.level === "high" ? 0.3 : 0.2;
      const bar = document.createElement("div");
      bar.style.cssText = `position:absolute;right:0;top:0;width:3px;height:100%;background:rgba(${proxRgb},${proxOp});box-shadow:0 0 8px rgba(${proxRgb},${(proxOp * 1.5).toFixed(2)}),0 0 16px rgba(${proxRgb},${proxOp});`;
      if (prox.level === "imminent") bar.className = "vdf-prox-pulse";
      vdZoneOverlayEl.appendChild(bar);
    }
  }
  function refreshVDZones() {
    if (!vdZoneOverlayEl || !currentChartTicker) return;
    const today = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const cached = vdfResultCache.get(`${currentChartTicker}|${today}`);
    if (cached) renderVDZones(cached);
    else renderVDZones(null);
  }
  async function runVDFDetection(ticker, force = false) {
    if (!ticker) return;
    if (vdfLoadingForTicker === ticker && !force) return;
    const today = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const cacheKey = `${ticker}|${today}`;
    if (!force && vdfResultCache.has(cacheKey)) {
      const cached = vdfResultCache.get(cacheKey);
      updateVDFButton(cached);
      renderVDZones(cached);
      renderVDFAnalysisPanel(cached);
      return;
    }
    vdfLoadingForTicker = ticker;
    setVDFButtonColor(VDF_COLOR_LOADING, "VDF: Loading...");
    try {
      const params = new URLSearchParams({ ticker, mode: "chart" });
      if (force) params.set("force", "1");
      const response = await fetch(`/api/chart/vdf-status?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (currentChartTicker !== ticker) return;
      const entry = {
        is_detected: result.is_detected || false,
        composite_score: Number(result.composite_score) || 0,
        status: result.status || "",
        weeks: Number(result.weeks) || 0,
        zones: Array.isArray(result.zones) ? result.zones : [],
        allZones: Array.isArray(result.allZones) ? result.allZones : Array.isArray(result.zones) ? result.zones : [],
        distribution: Array.isArray(result.distribution) ? result.distribution : [],
        proximity: result.proximity || { compositeScore: 0, level: "none", signals: [] },
        details: result.details || void 0
      };
      vdfResultCache.set(cacheKey, entry);
      if (vdfResultCache.size > VDF_CACHE_MAX_SIZE) {
        const oldest = vdfResultCache.keys().next().value;
        if (oldest !== void 0) vdfResultCache.delete(oldest);
      }
      updateVDFButton(entry);
      renderVDZones(entry);
      renderVDFAnalysisPanel(entry);
    } catch {
      if (currentChartTicker === ticker) {
        setVDFButtonColor(VDF_COLOR_ERROR, "VDF: Failed to load");
      }
    } finally {
      if (vdfLoadingForTicker === ticker) vdfLoadingForTicker = null;
    }
  }
  var VDF_COMPONENTS = [
    { key: "s8", label: "Divergence", defaultWeight: 35, tooltip: "Overall price-down + delta-up divergence. The PRIMARY thesis signal. Score = 0 when price is rising or delta is negative." },
    { key: "s6", label: "Absorption", defaultWeight: 25, tooltip: "Percentage of days where price fell but delta was positive. Day-by-day divergence confirmation: institutions buying the dip." },
    { key: "s1", label: "Net Delta", defaultWeight: 15, tooltip: "Total net buying as % of total volume. Supporting signal: is there net buying?" },
    { key: "s2", label: "Delta Slope", defaultWeight: 10, tooltip: "Trend of cumulative weekly delta. Supporting signal: is buying building over time?" },
    { key: "s3", label: "Delta Shift", defaultWeight: 5, tooltip: "Is buying stronger now than before? Compares avg daily delta in the zone to the pre-context period." },
    { key: "s4", label: "Accum Ratio", defaultWeight: 5, tooltip: "Fraction of weeks with positive delta. High ratio = persistent buying across multiple weeks." },
    { key: "s5", label: "Buy vs Sell", defaultWeight: 3, tooltip: "Ratio of large buy days to large sell days. Detects if big-volume days lean bullish or bearish." },
    { key: "s7", label: "Vol Decline", defaultWeight: 2, tooltip: "Volume declining from first-third to last-third of the zone. Supply drying up = fewer sellers remain." }
  ];
  var VDF_DEFAULT_WEIGHTS = {};
  VDF_COMPONENTS.forEach((c2) => {
    VDF_DEFAULT_WEIGHTS[c2.key] = c2.defaultWeight;
  });
  var vdfWeights = { ...VDF_DEFAULT_WEIGHTS };
  function loadVDFWeightsFromStorage() {
    try {
      const raw = localStorage.getItem("chart_vdf_weights");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          for (const c2 of VDF_COMPONENTS) {
            if (typeof parsed[c2.key] === "number") vdfWeights[c2.key] = parsed[c2.key];
          }
        }
      }
    } catch {
    }
  }
  function getVDFWeightTotal() {
    return VDF_COMPONENTS.reduce((s, c2) => s + (vdfWeights[c2.key] || 0), 0);
  }
  function recomputeVDFZoneScore(zone) {
    if (!zone.components) return zone.score;
    const total = getVDFWeightTotal();
    if (total <= 0) return 0;
    let rawScore = 0;
    for (const c2 of VDF_COMPONENTS) {
      const val = zone.components[c2.key] || 0;
      rawScore += val * ((vdfWeights[c2.key] || 0) / total);
    }
    const concordancePenalty = zone.concordancePenalty ?? 1;
    const durationMultiplier = zone.durationMultiplier ?? 1;
    return rawScore * concordancePenalty * durationMultiplier;
  }
  function getVDFComponentLabels() {
    const total = getVDFWeightTotal();
    return VDF_COMPONENTS.map((c2) => {
      const w2 = vdfWeights[c2.key] || 0;
      const pct = total > 0 ? Math.round(w2 / total * 100) : 0;
      return [c2.key, c2.label, `${pct}%`];
    });
  }
  function formatVDFDate(dateStr) {
    const parts = dateStr.split("-");
    if (parts.length < 3) return dateStr;
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }
  function vdfScoreTier(score) {
    if (score >= 80) return "Strong";
    if (score >= 60) return "Moderate";
    if (score >= 40) return "Weak";
    return "Marginal";
  }
  function vdfScoreColor(score) {
    if (score >= 80) return "#26a69a";
    if (score >= 60) return "#8bc34a";
    return "#c9d1d9";
  }
  function vdfProximityColor(level) {
    if (level === "imminent") return "#f44336";
    if (level === "high") return "#ff9800";
    if (level === "elevated") return "#ffc107";
    return "#8b949e";
  }
  function ensureVDFAnalysisPanel() {
    if (vdfAnalysisPanelEl) return vdfAnalysisPanelEl;
    const chartContent = document.getElementById("chart-content");
    if (!chartContent) return document.createElement("div");
    const panel = document.createElement("div");
    panel.id = "vdf-analysis-panel";
    panel.style.cssText = 'width:100%;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.5;overflow:hidden;display:none;';
    chartContent.appendChild(panel);
    vdfAnalysisPanelEl = panel;
    return panel;
  }
  function toggleVDFAnalysisPanel() {
    if (!vdfAnalysisPanelEl) return;
    const body = vdfAnalysisPanelEl.querySelector(".vdf-ap-body");
    if (!body) return;
    const isCollapsed = body.style.display === "none";
    body.style.display = isCollapsed ? "block" : "none";
    const chevron = vdfAnalysisPanelEl.querySelector(".vdf-ap-chevron");
    if (chevron) chevron.textContent = isCollapsed ? "\u25BE" : "\u25B8";
    try {
      localStorage.setItem("chart_vdf_panel_collapsed", isCollapsed ? "0" : "1");
    } catch {
    }
  }
  function buildComponentBarsHtml(components) {
    return getVDFComponentLabels().map(([key, label, weight]) => {
      const val = Number(components[key]) || 0;
      const pct = Math.max(0, Math.min(100, Math.round(val * 100)));
      const barColor = val >= 0.7 ? "#26a69a" : val >= 0.4 ? "#8bc34a" : "#484f58";
      return `<div style="display:grid;grid-template-columns:130px 1fr 36px;gap:6px;align-items:center;margin:2px 0;">
      <span style="color:#8b949e;font-size:11px;white-space:nowrap;">${escapeHtml(label)} (${weight})</span>
      <div style="height:4px;background:#21262d;border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;"></div>
      </div>
      <span style="color:#c9d1d9;font-size:11px;font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;text-align:right;">${val.toFixed(2)}</span>
    </div>`;
    }).join("");
  }
  function buildZoneHtml(zone, index, isBest) {
    const recomputed = recomputeVDFZoneScore(zone);
    const scoreInt = Math.round(recomputed * 100);
    const serverScoreInt = Math.round(zone.score * 100);
    const isCustomWeights = !VDF_COMPONENTS.every((c2) => vdfWeights[c2.key] === c2.defaultWeight);
    const label = isBest ? `Zone ${index + 1} (Primary)` : `Zone ${index + 1}`;
    const color = vdfScoreColor(scoreInt);
    let metricsLine = "";
    const parts = [];
    if (zone.overallPriceChange != null) parts.push(`Price: ${zone.overallPriceChange >= 0 ? "+" : ""}${zone.overallPriceChange.toFixed(1)}%`);
    if (zone.netDeltaPct != null) parts.push(`Net Delta: ${zone.netDeltaPct >= 0 ? "+" : ""}${zone.netDeltaPct.toFixed(1)}%`);
    if (zone.absorptionPct != null) parts.push(`Absorption: ${zone.absorptionPct.toFixed(1)}%`);
    if (parts.length) metricsLine = `<div style="margin:4px 0;color:#8b949e;font-size:12px;">${parts.join(" &nbsp;|&nbsp; ")}</div>`;
    let detailLine = "";
    const dParts = [];
    if (zone.accumWeeks != null && zone.weeks) dParts.push(`Accum weeks: ${zone.accumWeeks}/${zone.weeks} (${Math.round(zone.accumWeeks / zone.weeks * 100)}%)`);
    if (zone.durationMultiplier != null) dParts.push(`Duration: ${zone.durationMultiplier.toFixed(3)}x`);
    if (zone.concordancePenalty != null && zone.concordancePenalty < 1) dParts.push(`Concordance: ${zone.concordancePenalty.toFixed(3)}x`);
    if (dParts.length) detailLine = `<div style="margin:2px 0;color:#8b949e;font-size:12px;">${dParts.join(" &nbsp;|&nbsp; ")}</div>`;
    let componentsHtml = "";
    if (zone.components) {
      componentsHtml = `<div style="margin-top:8px;"><div style="color:#8b949e;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Components</div>${buildComponentBarsHtml(zone.components)}</div>`;
    }
    const scoreDiffHtml = isCustomWeights && serverScoreInt !== scoreInt ? `<span style="font-size:10px;color:#484f58;margin-left:4px;" title="Server score with default weights">(was ${serverScoreInt})</span>` : "";
    return `<div style="background:#161b22;border:1px solid #21262d;border-radius:4px;padding:12px;margin-bottom:8px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <span style="font-weight:600;font-size:13px;color:#c9d1d9;">${escapeHtml(label)}</span>
      <span><span style="font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:13px;font-weight:700;color:${color};">${scoreInt}</span>${scoreDiffHtml}</span>
    </div>
    <div style="color:#c9d1d9;font-size:12px;">${formatVDFDate(zone.startDate)} \u2192 ${formatVDFDate(zone.endDate)} (${zone.windowDays} trading days${zone.weeks ? `, ${zone.weeks} wk` : ""})</div>
    ${metricsLine}
    ${detailLine}
    ${componentsHtml}
  </div>`;
  }
  function buildDistributionHtml(dist, index) {
    let detail = "";
    const parts = [];
    if (dist.priceChangePct != null) parts.push(`Price ${dist.priceChangePct >= 0 ? "+" : ""}${dist.priceChangePct.toFixed(1)}%`);
    if (dist.netDeltaPct != null) parts.push(`Delta ${dist.netDeltaPct >= 0 ? "+" : ""}${dist.netDeltaPct.toFixed(1)}%`);
    if (parts.length) detail = parts.join(" while ") + " \u2014 selling into strength.";
    return `<div style="background:rgba(239,83,80,0.06);border:1px solid rgba(239,83,80,0.2);border-radius:4px;padding:10px 12px;margin-bottom:8px;">
    <div style="font-weight:600;font-size:12px;color:#ef5350;margin-bottom:2px;">Cluster ${index + 1}: ${formatVDFDate(dist.startDate)} \u2192 ${formatVDFDate(dist.endDate)} (${dist.spanDays} days)</div>
    ${detail ? `<div style="color:#8b949e;font-size:12px;">${escapeHtml(detail)}</div>` : ""}
  </div>`;
  }
  function buildProximityHtml(prox) {
    if (prox.level === "none" && prox.compositeScore === 0) return "";
    const levelLabel = prox.level.charAt(0).toUpperCase() + prox.level.slice(1);
    const levelColor = vdfProximityColor(prox.level);
    const signalRows = prox.signals.map(
      (sig) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;font-size:12px;">
      <span style="color:#c9d1d9;">\u2713 ${escapeHtml(sig.detail)}</span>
      <span style="color:${levelColor};font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-weight:600;white-space:nowrap;margin-left:12px;">+${sig.points}</span>
    </div>`
    ).join("");
    return `<div style="margin-top:4px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:13px;font-weight:700;color:${levelColor};">${prox.compositeScore} pts</span>
      <span style="font-size:11px;font-weight:600;color:${levelColor};border:1px solid ${levelColor};border-radius:3px;padding:0 5px;line-height:16px;">${levelLabel}</span>
    </div>
    ${signalRows}
  </div>`;
  }
  function renderVDFAnalysisPanel(entry) {
    loadVDFWeightsFromStorage();
    const panel = ensureVDFAnalysisPanel();
    if (!entry) {
      panel.style.display = "none";
      panel.innerHTML = "";
      return;
    }
    const ticker = currentChartTicker || "";
    const bestZone = entry.zones[0];
    const recomputedBestScore = bestZone ? Math.round(recomputeVDFZoneScore(bestZone) * 100) : 0;
    const score = entry.is_detected ? recomputedBestScore : Math.round(entry.composite_score * 100);
    const tier = vdfScoreTier(score);
    const color = vdfScoreColor(score);
    const metrics = entry.details?.metrics;
    let collapsed = true;
    try {
      collapsed = localStorage.getItem("chart_vdf_panel_collapsed") !== "0";
    } catch {
    }
    if (entry.is_detected && !localStorage.getItem("chart_vdf_panel_collapsed")) collapsed = false;
    const chevron = collapsed ? "\u25B8" : "\u25BE";
    const bodyDisplay = collapsed ? "none" : "block";
    const headerHtml = `<div class="vdf-ap-header" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;cursor:pointer;user-select:none;border-bottom:1px solid #21262d;">
    <div style="display:flex;align-items:center;gap:8px;">
      <span class="vdf-ap-chevron" style="font-size:12px;color:#8b949e;width:12px;">${chevron}</span>
      <span style="font-weight:600;color:#c9d1d9;">VD Analysis</span>
      <span style="color:#8b949e;font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:12px;">${escapeHtml(ticker)}</span>
    </div>
    <div style="display:flex;align-items:center;">
      ${entry.is_detected ? `<span style="font-family:'SF Mono',Menlo,Monaco,Consolas,monospace;font-size:13px;font-weight:700;color:${color};">${score}</span>` : `<span style="font-size:11px;color:#484f58;">Not detected</span>`}
    </div>
  </div>`;
    let bodyHtml = "";
    if (!entry.is_detected) {
      let scanInfo = "";
      if (metrics?.scanStart && metrics?.scanEnd) {
        scanInfo = ` Scan: ${formatVDFDate(metrics.scanStart)} \u2192 ${formatVDFDate(metrics.scanEnd)}`;
        if (metrics.totalDays) scanInfo += ` (${metrics.totalDays} trading days)`;
        scanInfo += ".";
      }
      bodyHtml = `<div style="padding:14px;color:#8b949e;font-size:13px;">No accumulation patterns detected in the scan period.${scanInfo}</div>`;
    } else {
      const zoneCount = entry.zones.length;
      let assessParts = `Volume-delta accumulation <span style="color:${color};font-weight:600;">${tier}</span> (score: ${score}).`;
      assessParts += ` ${zoneCount} accumulation zone${zoneCount !== 1 ? "s" : ""} detected`;
      if (entry.weeks) assessParts += ` spanning up to ${entry.weeks} weeks`;
      assessParts += ".";
      if (metrics?.scanStart && metrics?.scanEnd) {
        assessParts += ` Scan: ${formatVDFDate(metrics.scanStart)} \u2192 ${formatVDFDate(metrics.scanEnd)}`;
        if (metrics.totalDays) assessParts += ` (${metrics.totalDays} trading days)`;
        assessParts += ".";
      }
      if (entry.distribution.length > 0) {
        assessParts += ` <span style="color:#ef5350;">${entry.distribution.length} distribution cluster${entry.distribution.length !== 1 ? "s" : ""}</span> also found.`;
      }
      const assessHtml = `<div style="margin-bottom:16px;font-size:13px;color:#c9d1d9;">${assessParts}</div>`;
      const swatchStyle = "display:inline-block;width:14px;height:5px;border-radius:1px;vertical-align:middle;margin-right:5px;";
      const dashStyle = "display:inline-block;width:14px;height:0;border-top:1px dashed;vertical-align:middle;margin-right:5px;";
      const glowStyle = "display:inline-block;width:3px;height:12px;border-radius:1px;vertical-align:middle;margin-right:5px;";
      const legendItems = [];
      legendItems.push(`<span style="white-space:nowrap;"><span style="${swatchStyle}background:rgba(38,166,154,0.7);"></span>Accumulation</span>`);
      if (entry.distribution.length > 0) {
        legendItems.push(`<span style="white-space:nowrap;"><span style="${swatchStyle}background:rgba(239,83,80,0.65);"></span>Distribution</span>`);
      }
      const hasAbsorption = entry.zones.some((z2) => (z2.absorptionPct || 0) >= 5);
      if (hasAbsorption) {
        legendItems.push(`<span style="white-space:nowrap;"><span style="${swatchStyle}background:rgba(255,167,38,0.7);"></span>Absorption</span>`);
      }
      legendItems.push(`<span style="white-space:nowrap;"><span style="${dashStyle}border-color:rgba(38,166,154,0.4);"></span>Zone bounds</span>`);
      const proxLegend = entry.proximity;
      if (proxLegend && proxLegend.level !== "none" && proxLegend.compositeScore > 0) {
        const plc = vdfProximityColor(proxLegend.level);
        legendItems.push(`<span style="white-space:nowrap;"><span style="${glowStyle}background:${plc};box-shadow:0 0 4px ${plc};"></span>Proximity</span>`);
      }
      const legendHtml = `<div style="display:flex;flex-wrap:wrap;gap:12px 16px;padding:8px 12px;background:#161b22;border:1px solid #21262d;border-radius:4px;margin-bottom:16px;font-size:11px;color:#8b949e;">${legendItems.join("")}</div>`;
      const sectionStyle = "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#8b949e;margin:16px 0 8px;border-bottom:1px solid #21262d;padding-bottom:4px;";
      let zonesHtml = "";
      if (entry.zones.length > 0) {
        zonesHtml = `<div style="${sectionStyle}">Accumulation Zones</div>`;
        zonesHtml += entry.zones.map((z2, i) => buildZoneHtml(z2, i, i === 0)).join("");
      }
      let distHtml = "";
      if (entry.distribution.length > 0) {
        distHtml = `<div style="${sectionStyle}">Distribution Clusters</div>`;
        distHtml += entry.distribution.map((d2, i) => buildDistributionHtml(d2, i)).join("");
      }
      let proxHtml = "";
      const prox = entry.proximity;
      if (prox && (prox.level !== "none" || prox.compositeScore > 0)) {
        const levelLabel = prox.level.charAt(0).toUpperCase() + prox.level.slice(1);
        proxHtml = `<div style="${sectionStyle}">Proximity Signals (${prox.compositeScore} pts \u2014 ${levelLabel})</div>`;
        proxHtml += buildProximityHtml(prox);
      }
      bodyHtml = `<div style="padding:14px;">${assessHtml}${legendHtml}${zonesHtml}${distHtml}${proxHtml}</div>`;
    }
    panel.innerHTML = `${headerHtml}<div class="vdf-ap-body" style="display:${bodyDisplay};">${bodyHtml}</div>`;
    panel.style.display = "block";
    const header = panel.querySelector(".vdf-ap-header");
    if (header) {
      header.addEventListener("click", () => {
        toggleVDFAnalysisPanel();
      });
    }
  }
  function applyPricePaneDivergentBarColors() {
    if (!candleSeries) return;
    if (!Array.isArray(currentBars) || currentBars.length === 0) {
      candleSeries.setData([]);
      return;
    }
    if (!volumeDeltaSettings.divergentPriceBars) {
      candleSeries.setData(currentBars);
      return;
    }
    const bullishColor = volumeDeltaSettings.bullishDivergentColor || DEFAULT_VOLUME_DELTA_SETTINGS.bullishDivergentColor;
    const bearishColor = volumeDeltaSettings.bearishDivergentColor || DEFAULT_VOLUME_DELTA_SETTINGS.bearishDivergentColor;
    const configuredNeutral = String(volumeDeltaSettings.neutralDivergentColor || "").trim().toLowerCase();
    const convergentColor = configuredNeutral === "#c9d1d9" ? DEFAULT_VOLUME_DELTA_SETTINGS.neutralDivergentColor : volumeDeltaSettings.neutralDivergentColor || DEFAULT_VOLUME_DELTA_SETTINGS.neutralDivergentColor;
    const barsWithBodyColor = currentBars.map((bar, index) => {
      const close = Number(bar?.close);
      const prevClose = Number(currentBars[index - 1]?.close);
      const delta = Number(volumeDeltaByTime.get(timeKey(bar.time)));
      const hasComparableBar = index > 0 && Number.isFinite(close) && Number.isFinite(prevClose);
      const hasDelta = Number.isFinite(delta);
      let bodyColor = convergentColor;
      if (hasComparableBar && hasDelta) {
        const isBullishDivergence = delta > 0 && close < prevClose;
        const isBearishDivergence = delta < 0 && close > prevClose;
        if (isBullishDivergence) {
          bodyColor = bullishColor;
        } else if (isBearishDivergence) {
          bodyColor = bearishColor;
        }
      }
      return {
        ...bar,
        color: bodyColor
      };
    });
    candleSeries.setData(barsWithBodyColor);
  }
  function normalizeCandleBars(bars) {
    return bars.filter((bar) => bar && (typeof bar.time === "string" || typeof bar.time === "number") && Number.isFinite(Number(bar.open)) && Number.isFinite(Number(bar.high)) && Number.isFinite(Number(bar.low)) && Number.isFinite(Number(bar.close)));
  }
  function applyChartSizes(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer) {
    if (!priceChart) return;
    const chartRect = chartContainer.getBoundingClientRect();
    const volumeDeltaRsiRect = volumeDeltaRsiContainer.getBoundingClientRect();
    const rsiRect = rsiContainer.getBoundingClientRect();
    const volumeDeltaRect = volumeDeltaContainer.getBoundingClientRect();
    const priceWidth = Math.max(1, Math.floor(chartRect.width));
    const priceHeight = Math.max(1, Math.floor(chartRect.height));
    const volumeDeltaRsiWidth = Math.max(1, Math.floor(volumeDeltaRsiRect.width));
    const volumeDeltaRsiHeight = Math.max(1, Math.floor(volumeDeltaRsiRect.height));
    const rsiWidth = Math.max(1, Math.floor(rsiRect.width));
    const rsiHeight = Math.max(1, Math.floor(rsiRect.height));
    const volumeDeltaWidth = Math.max(1, Math.floor(volumeDeltaRect.width));
    const volumeDeltaHeight = Math.max(1, Math.floor(volumeDeltaRect.height));
    priceChart.applyOptions({ width: priceWidth, height: priceHeight });
    if (volumeDeltaRsiChart) {
      volumeDeltaRsiChart.applyOptions({ width: volumeDeltaRsiWidth, height: volumeDeltaRsiHeight });
    }
    if (rsiChart) {
      rsiChart.getChart().applyOptions({ width: rsiWidth, height: rsiHeight });
      rsiChart.refreshTrendlineLabels();
    }
    if (volumeDeltaChart) {
      volumeDeltaChart.applyOptions({ width: volumeDeltaWidth, height: volumeDeltaHeight });
    }
    scheduleChartLayoutRefresh();
  }
  function ensureResizeObserver(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer) {
    if (chartResizeObserver) return;
    chartResizeObserver = new ResizeObserver(() => {
      applyChartSizes(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
    });
    chartResizeObserver.observe(chartContainer);
    chartResizeObserver.observe(volumeDeltaRsiContainer);
    chartResizeObserver.observe(rsiContainer);
    chartResizeObserver.observe(volumeDeltaContainer);
  }
  function applyPersistedPaneHeights(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer) {
    const containers = [chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer];
    for (const c2 of containers) {
      const h2 = paneHeights[c2.id];
      if (h2 && h2 >= PANE_HEIGHT_MIN && h2 <= PANE_HEIGHT_MAX) {
        c2.style.height = `${h2}px`;
      }
    }
  }
  function ensurePaneResizeHandles(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer) {
    if (paneResizeHandlesInstalled) return;
    paneResizeHandlesInstalled = true;
    const containers = [chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer];
    for (const container of containers) {
      const handle = document.createElement("div");
      handle.className = "pane-resize-handle";
      container.appendChild(handle);
      let startY = 0;
      let startHeight = 0;
      const onPointerMove = (e2) => {
        const delta = e2.clientY - startY;
        const newHeight = Math.min(PANE_HEIGHT_MAX, Math.max(PANE_HEIGHT_MIN, startHeight + delta));
        container.style.height = `${newHeight}px`;
      };
      const onPointerUp = (e2) => {
        handle.classList.remove("active");
        handle.releasePointerCapture(e2.pointerId);
        handle.removeEventListener("pointermove", onPointerMove);
        handle.removeEventListener("pointerup", onPointerUp);
        const finalHeight = container.getBoundingClientRect().height;
        paneHeights[container.id] = Math.round(finalHeight);
        persistSettingsToStorage();
      };
      handle.addEventListener("pointerdown", (e2) => {
        e2.preventDefault();
        e2.stopPropagation();
        startY = e2.clientY;
        startHeight = container.getBoundingClientRect().height;
        handle.classList.add("active");
        handle.setPointerCapture(e2.pointerId);
        handle.addEventListener("pointermove", onPointerMove);
        handle.addEventListener("pointerup", onPointerUp);
      });
      handle.addEventListener("dblclick", (e2) => {
        e2.preventDefault();
        e2.stopPropagation();
        const defaultH = DEFAULT_PANE_HEIGHTS[container.id];
        if (defaultH) {
          container.style.height = `${defaultH}px`;
          delete paneHeights[container.id];
          persistSettingsToStorage();
        }
      });
    }
  }
  function showLoadingOverlay(container) {
    const existingOverlay = container.querySelector(".chart-loading-overlay");
    if (existingOverlay) {
      existingOverlay.remove();
    }
    const overlay = document.createElement("div");
    overlay.className = "chart-loading-overlay";
    overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(13, 17, 23, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    pointer-events: none;
  `;
    const spinner = document.createElement("div");
    spinner.innerHTML = `
    <svg width="40" height="40" viewBox="0 0 40 40" style="animation: spin 1s linear infinite;">
      <circle cx="20" cy="20" r="16" fill="none" stroke="#58a6ff" stroke-width="3"
              stroke-dasharray="80" stroke-dashoffset="60" stroke-linecap="round" opacity="0.8"/>
    </svg>
    <style>
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
    </style>
  `;
    overlay.appendChild(spinner);
    container.appendChild(overlay);
  }
  function showRetryOverlay(container, onRetry) {
    const existingOverlay = container.querySelector(".chart-loading-overlay");
    if (existingOverlay) {
      existingOverlay.remove();
    }
    const overlay = document.createElement("div");
    overlay.className = "chart-loading-overlay";
    overlay.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(13, 17, 23, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    pointer-events: auto;
  `;
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.textContent = "Try Refreshing";
    retryBtn.style.background = "#161b22";
    retryBtn.style.color = "#c9d1d9";
    retryBtn.style.border = "1px solid #30363d";
    retryBtn.style.borderRadius = "6px";
    retryBtn.style.padding = "8px 12px";
    retryBtn.style.fontSize = "12px";
    retryBtn.style.fontWeight = "600";
    retryBtn.style.cursor = "pointer";
    retryBtn.style.fontFamily = "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace";
    retryBtn.addEventListener("click", (event) => {
      event.preventDefault();
      onRetry();
    });
    overlay.appendChild(retryBtn);
    container.appendChild(overlay);
  }
  function hideLoadingOverlay(container) {
    const overlay = container.querySelector(".chart-loading-overlay");
    if (overlay) {
      overlay.remove();
    }
  }
  function scheduleIntervalChartRender(interval) {
    const scheduledTicker = currentChartTicker;
    if (!scheduledTicker) return;
    if (intervalSwitchDebounceTimer !== null) {
      window.clearTimeout(intervalSwitchDebounceTimer);
      intervalSwitchDebounceTimer = null;
    }
    intervalSwitchDebounceTimer = window.setTimeout(() => {
      intervalSwitchDebounceTimer = null;
      if (!currentChartTicker || currentChartTicker !== scheduledTicker) return;
      renderCustomChart(scheduledTicker, interval);
    }, INTERVAL_SWITCH_DEBOUNCE_MS);
  }
  function isTickerChartVisible() {
    if (document.visibilityState !== "visible") return false;
    const liveView = document.getElementById("view-live");
    if (liveView?.classList.contains("hidden")) return false;
    const tickerView = document.getElementById("ticker-view");
    if (tickerView?.classList.contains("hidden")) return false;
    return true;
  }
  function patchLatestBarInPlaceFromPayload(data) {
    if (!candleSeries || !rsiChart || !volumeDeltaRsiSeries || !volumeDeltaHistogramSeries) return false;
    if (!Array.isArray(currentBars) || currentBars.length === 0) return false;
    const currentLastIndex = currentBars.length - 1;
    const currentLast = currentBars[currentLastIndex];
    const fetchedLast = data.latestBar;
    if (!fetchedLast) return false;
    if (timeKey(currentLast?.time) !== timeKey(fetchedLast.time)) {
      return false;
    }
    const lastTime = currentLast.time;
    const lastKey = timeKey(lastTime);
    currentBars[currentLastIndex] = {
      ...currentLast,
      ...fetchedLast
    };
    const latestClose = Number(currentBars[currentLastIndex].close);
    if (Number.isFinite(latestClose)) {
      priceByTime.set(lastKey, latestClose);
    }
    barIndexByTime.set(lastKey, currentLastIndex);
    if (currentLastIndex > 0) {
      const prevClose = Number(currentBars[currentLastIndex - 1]?.close);
      if (Number.isFinite(prevClose) && prevClose !== 0 && Number.isFinite(latestClose)) {
        const percentChange = (latestClose - prevClose) / prevClose * 100;
        priceChangeByTime.set(lastKey, percentChange);
      }
    }
    const latestRsi = Number(data.latestRsi?.value);
    if (Number.isFinite(latestRsi)) {
      rsiByTime.set(lastKey, Number(latestRsi));
      const updated = rsiChart.updateLatestPoint(
        { time: lastTime, value: Number(latestRsi) },
        Number.isFinite(latestClose) ? { time: lastTime, close: latestClose } : void 0
      );
      if (!updated) return false;
    }
    const latestVdRsi = Number(data.latestVolumeDeltaRsi?.value);
    if (Number.isFinite(latestVdRsi)) {
      const normalizedVdRsi = normalizeVolumeDeltaValue(Number(latestVdRsi));
      volumeDeltaRsiByTime.set(lastKey, normalizedVdRsi);
      if (volumeDeltaRsiPoints.length > 0 && timeKey(volumeDeltaRsiPoints[volumeDeltaRsiPoints.length - 1].time) === lastKey) {
        volumeDeltaRsiPoints[volumeDeltaRsiPoints.length - 1] = {
          ...volumeDeltaRsiPoints[volumeDeltaRsiPoints.length - 1],
          value: normalizedVdRsi
        };
      }
      volumeDeltaRsiSeries.update({
        time: lastTime,
        value: normalizedVdRsi
      });
    }
    const latestDelta = Number(data.latestVolumeDelta?.delta);
    if (Number.isFinite(latestDelta)) {
      const numericDelta = Number(latestDelta);
      volumeDeltaByTime.set(lastKey, numericDelta);
      volumeDeltaHistogramSeries.update({
        time: lastTime,
        value: numericDelta,
        color: numericDelta >= 0 ? VOLUME_DELTA_POSITIVE_COLOR : VOLUME_DELTA_NEGATIVE_COLOR
      });
    }
    if (volumeDeltaSettings.divergentPriceBars) {
      applyPricePaneDivergentBarColors();
    } else {
      candleSeries.update(currentBars[currentLastIndex]);
    }
    updateMovingAveragesLatestPoint();
    if (pricePaneContainerEl) {
      setPricePaneChange(pricePaneContainerEl, null);
    }
    if (volumeDeltaPaneContainerEl) {
      renderVolumeDeltaDivergenceSummary(volumeDeltaPaneContainerEl, currentBars);
    }
    refreshActiveDivergenceOverlays();
    return true;
  }
  async function refreshLatestChartDataInPlace(ticker, interval) {
    const fetchStartedAt = performance.now();
    let responseCacheHeader = null;
    const data = await fetchChartLatestData(ticker, interval, {
      vdRsiLength: volumeDeltaRsiSettings.length,
      vdSourceInterval: volumeDeltaSettings.sourceInterval,
      vdRsiSourceInterval: volumeDeltaRsiSettings.sourceInterval,
      onResponseMeta: (meta) => {
        responseCacheHeader = meta.chartCacheHeader;
      }
    });
    recordChartFetchPerf(interval, performance.now() - fetchStartedAt, responseCacheHeader);
    if (!currentChartTicker || currentChartTicker !== ticker || currentChartInterval !== interval) return;
    if (!Array.isArray(currentBars) || currentBars.length === 0) return;
    const currentLastTime = currentBars[currentBars.length - 1]?.time;
    const fetchedLast = data.latestBar;
    if (currentLastTime === void 0 || currentLastTime === null || !fetchedLast) {
      await renderCustomChart(ticker, interval, { silent: true });
      return;
    }
    const currentLastKey = timeKey(currentLastTime);
    const fetchedLastKey = timeKey(fetchedLast.time);
    if (currentLastKey !== fetchedLastKey) {
      await renderCustomChart(ticker, interval, { silent: true });
      return;
    }
    const patched = patchLatestBarInPlaceFromPayload(data);
    if (!patched) {
      await renderCustomChart(ticker, interval, { silent: true });
    }
  }
  function applyChartDataToUi(data, chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer) {
    const bars = normalizeCandleBars(data.bars || []);
    if (bars.length === 0) {
      throw new Error("No valid chart bars returned for this ticker/interval");
    }
    monthBoundaryTimes = buildMonthBoundaryTimes(bars);
    applyFutureTimelineSeriesData(bars);
    const rsiData = buildRSISeriesFromBars(bars, rsiSettings.length);
    const volumeDeltaRsiData = {
      rsi: normalizeValueSeries(data.volumeDeltaRsi?.rsi || [])
    };
    const volumeDeltaData = normalizeVolumeDeltaSeries(data.volumeDelta || []);
    currentBars = bars;
    barIndexByTime = /* @__PURE__ */ new Map();
    for (let i = 0; i < bars.length; i++) {
      barIndexByTime.set(timeKey(bars[i].time), i);
    }
    rebuildPricePaneChangeMap(bars);
    priceByTime = new Map(
      bars.map((bar) => [timeKey(bar.time), Number(bar.close)])
    );
    rsiByTime = new Map(
      rsiData.filter((point) => Number.isFinite(Number(point.value))).map((point) => [timeKey(point.time), Number(point.value)])
    );
    if (candleSeries) {
      candleSeries.setData(bars);
    }
    setPricePaneChange(chartContainer, null);
    setVolumeDeltaRsiData(bars, volumeDeltaRsiData);
    setVolumeDeltaHistogramData(bars, volumeDeltaData);
    renderVolumeDeltaDivergenceSummary(volumeDeltaContainer, bars);
    applyVolumeDeltaRSIVisualSettings();
    if (!rsiChart && rsiContainer) {
      rsiChart = new RSIChart({
        container: rsiContainer,
        data: rsiData,
        displayMode: "line",
        lineColor: rsiSettings.lineColor,
        midlineColor: rsiSettings.midlineColor,
        midlineStyle: rsiSettings.midlineStyle,
        priceData: bars.map((b2) => ({ time: b2.time, close: b2.close })),
        onTrendLineDrawn: () => {
          rsiChart?.deactivateDivergenceTool();
          rsiDivergenceToolActive = false;
          setPaneTrendlineToolActive("rsi", false);
          persistTrendlinesForCurrentContext();
        }
      });
      applyChartSizes(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
      applyPaneScaleVisibilityByPosition();
    } else if (rsiChart) {
      rsiChart.setData(rsiData, bars.map((b2) => ({ time: b2.time, close: b2.close })));
    }
    applyRSISettings();
    restorePersistedTrendlinesForCurrentContext();
    setupChartSync();
    applyMovingAverages();
    applyRightMargin();
    syncChartsToPriceRange();
    scheduleChartLayoutRefresh();
    if (currentChartTicker) {
      runVDFDetection(currentChartTicker);
    }
  }
  function ensureChartLiveRefreshTimer() {
    if (chartLiveRefreshTimer !== null) return;
    chartLiveRefreshTimer = window.setInterval(() => {
      if (chartLiveRefreshInFlight) return;
      if (chartFetchAbortController) return;
      if (!currentChartTicker) return;
      if (!isTickerChartVisible()) return;
      const scheduledTicker = currentChartTicker;
      const scheduledInterval = currentChartInterval;
      chartLiveRefreshInFlight = true;
      refreshLatestChartDataInPlace(scheduledTicker, scheduledInterval).catch(() => {
      }).finally(() => {
        chartLiveRefreshInFlight = false;
      });
    }, CHART_LIVE_REFRESH_MS);
  }
  function isChartActivelyLoading() {
    return chartActivelyLoading;
  }
  function abortPrefetches() {
    if (prefetchAbortController) {
      try {
        prefetchAbortController.abort();
      } catch {
      }
      prefetchAbortController = null;
    }
  }
  function cancelChartLoading() {
    if (chartFetchAbortController) {
      try {
        chartFetchAbortController.abort();
      } catch {
      }
      chartFetchAbortController = null;
    }
    abortPrefetches();
    if (chartLiveRefreshTimer !== null) {
      window.clearInterval(chartLiveRefreshTimer);
      chartLiveRefreshTimer = null;
    }
    chartLiveRefreshInFlight = false;
    chartActivelyLoading = false;
    latestRenderRequestId++;
  }
  async function renderCustomChart(ticker, interval = currentChartInterval, options = {}) {
    const silent = options.silent === true;
    ensureSettingsLoadedFromStorage();
    const previousTicker = currentChartTicker;
    const previousInterval = currentChartInterval;
    const requestId = ++latestRenderRequestId;
    const contextChanged = typeof previousTicker === "string" && (previousTicker !== ticker || previousInterval !== interval);
    const shouldApplyWeeklyDefaultRange = interval === "1week" && (typeof previousTicker !== "string" || contextChanged);
    currentChartInterval = interval;
    currentChartTicker = ticker;
    const cacheKey = buildChartDataCacheKey(ticker, interval);
    if (contextChanged) {
      rsiDivergencePlotSelected = false;
      volumeDeltaRsiDivergencePlotSelected = false;
      rsiDivergencePlotStartIndex = null;
      volumeDeltaRsiDivergencePlotStartIndex = null;
      rsiDivergencePlotToolActive = false;
      volumeDeltaRsiDivergencePlotToolActive = false;
      volumeDeltaDivergenceToolActive = false;
      rsiDivergenceToolActive = false;
      hideDivergenceOverlay("rsi");
      hideDivergenceOverlay("volumeDeltaRsi");
      isChartSyncBound = false;
      crosshairHidden = false;
      if (vdfAnalysisPanelEl) {
        vdfAnalysisPanelEl.style.display = "none";
        vdfAnalysisPanelEl.innerHTML = "";
      }
    }
    const chartContent = document.getElementById("chart-content");
    if (!chartContent || !(chartContent instanceof HTMLElement)) {
      console.error("Chart content container not found");
      return;
    }
    ensurePaneReorderUI(chartContent);
    const chartContainer = document.getElementById("price-chart-container");
    const volumeDeltaRsiContainer = document.getElementById("vd-rsi-chart-container");
    const rsiContainer = document.getElementById("rsi-chart-container");
    const volumeDeltaContainer = document.getElementById("vd-chart-container");
    const errorContainer = document.getElementById("chart-error");
    if (!chartContainer || !volumeDeltaRsiContainer || !rsiContainer || !volumeDeltaContainer || !errorContainer) {
      console.error("Chart containers not found");
      return;
    }
    pricePaneContainerEl = chartContainer;
    volumeDeltaPaneContainerEl = volumeDeltaContainer;
    errorContainer.style.display = "none";
    errorContainer.textContent = "";
    setPricePaneMessage(chartContainer, null);
    ensureMonthGridOverlay(chartContainer, "price");
    ensureMonthGridOverlay(volumeDeltaRsiContainer, "volumeDeltaRsi");
    ensureMonthGridOverlay(rsiContainer, "rsi");
    ensureMonthGridOverlay(volumeDeltaContainer, "volumeDelta");
    ensureVDZoneOverlay(chartContainer);
    ensureVDFAnalysisPanel();
    ensureSettingsUI(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
    syncTopPaneTickerLabel();
    if (!priceChart) {
      const { chart, series, timelineSeries } = createPriceChart(chartContainer);
      priceChart = chart;
      candleSeries = series;
      priceTimelineSeries = timelineSeries;
      applyPriceGridOptions();
    }
    if (!volumeDeltaRsiChart) {
      const { chart, rsiSeries, timelineSeries } = createVolumeDeltaRsiChart(volumeDeltaRsiContainer);
      volumeDeltaRsiChart = chart;
      volumeDeltaRsiSeries = rsiSeries;
      volumeDeltaRsiTimelineSeries = timelineSeries;
      applyVolumeDeltaRSIVisualSettings();
    }
    if (!volumeDeltaChart) {
      const { chart, histogramSeries, timelineSeries } = createVolumeDeltaChart(volumeDeltaContainer);
      volumeDeltaChart = chart;
      volumeDeltaHistogramSeries = histogramSeries;
      volumeDeltaTimelineSeries = timelineSeries;
    }
    applyPersistedPaneHeights(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
    ensureResizeObserver(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
    ensurePaneResizeHandles(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
    applyChartSizes(chartContainer, volumeDeltaRsiContainer, rsiContainer, volumeDeltaContainer);
    applyPaneScaleVisibilityByPosition();
    const cachedData = silent ? null : getCachedChartData(cacheKey);
    const hasCachedData = Boolean(cachedData);
    if (cachedData) {
      const renderStartedAt = performance.now();
      applyChartDataToUi(
        cachedData,
        chartContainer,
        volumeDeltaRsiContainer,
        rsiContainer,
        volumeDeltaContainer
      );
      recordChartRenderPerf(interval, performance.now() - renderStartedAt);
      if (shouldApplyWeeklyDefaultRange) {
        applyWeeklyInitialVisibleRange();
      }
      prefetchRelatedIntervals(ticker, interval);
    } else if (!silent) {
      showLoadingOverlay(chartContainer);
      showLoadingOverlay(volumeDeltaRsiContainer);
      showLoadingOverlay(rsiContainer);
      showLoadingOverlay(volumeDeltaContainer);
    }
    abortPrefetches();
    if (chartFetchAbortController) {
      try {
        chartFetchAbortController.abort();
      } catch {
      }
    }
    const fetchController = new AbortController();
    chartFetchAbortController = fetchController;
    if (!silent) chartActivelyLoading = true;
    try {
      const fetchStartedAt = performance.now();
      let responseCacheHeader = null;
      const data = await fetchChartData(ticker, interval, {
        vdRsiLength: volumeDeltaRsiSettings.length,
        vdSourceInterval: volumeDeltaSettings.sourceInterval,
        vdRsiSourceInterval: volumeDeltaRsiSettings.sourceInterval,
        signal: fetchController.signal,
        onResponseMeta: (meta) => {
          responseCacheHeader = meta.chartCacheHeader;
        }
      });
      recordChartFetchPerf(interval, performance.now() - fetchStartedAt, responseCacheHeader);
      if (requestId !== latestRenderRequestId) return;
      const shouldApplyFreshData = !hasCachedData || getLastBarSignature(cachedData) !== getLastBarSignature(data);
      if (shouldApplyFreshData) {
        const renderStartedAt = performance.now();
        applyChartDataToUi(
          data,
          chartContainer,
          volumeDeltaRsiContainer,
          rsiContainer,
          volumeDeltaContainer
        );
        recordChartRenderPerf(interval, performance.now() - renderStartedAt);
        if (shouldApplyWeeklyDefaultRange) {
          applyWeeklyInitialVisibleRange();
        }
      }
      setCachedChartData(cacheKey, data);
      prefetchRelatedIntervals(ticker, interval);
      if (!silent) {
        hideLoadingOverlay(chartContainer);
        hideLoadingOverlay(volumeDeltaRsiContainer);
        hideLoadingOverlay(rsiContainer);
        hideLoadingOverlay(volumeDeltaContainer);
      }
    } catch (err) {
      if (requestId !== latestRenderRequestId) return;
      if (err?.name === "AbortError") return;
      console.error("Failed to load chart:", err);
      if (silent) {
        return;
      }
      if (hasCachedData) {
        return;
      }
      if (isNoDataTickerError(err)) {
        hideLoadingOverlay(chartContainer);
        hideLoadingOverlay(volumeDeltaRsiContainer);
        hideLoadingOverlay(rsiContainer);
        hideLoadingOverlay(volumeDeltaContainer);
        if (candleSeries) {
          candleSeries.setData([]);
        }
        priceChangeByTime = /* @__PURE__ */ new Map();
        setPricePaneChange(chartContainer, null);
        if (rsiChart) {
          rsiChart.setData([], []);
        }
        if (volumeDeltaRsiChart) {
          volumeDeltaRsiSeries?.setData([]);
        }
        if (volumeDeltaChart) {
          volumeDeltaHistogramSeries?.setData([]);
        }
        applyFutureTimelineSeriesData([]);
        clearVolumeDeltaDivergence();
        volumeDeltaRsiPoints = [];
        volumeDeltaIndexByTime = /* @__PURE__ */ new Map();
        volumeDeltaRsiByTime = /* @__PURE__ */ new Map();
        volumeDeltaByTime = /* @__PURE__ */ new Map();
        clearVolumeDeltaDivergenceSummary();
        currentBars = [];
        barIndexByTime = /* @__PURE__ */ new Map();
        clearMovingAverageSeries();
        monthBoundaryTimes = [];
        clearMonthGridOverlay(priceMonthGridOverlayEl);
        clearMonthGridOverlay(volumeDeltaRsiMonthGridOverlayEl);
        clearMonthGridOverlay(volumeDeltaMonthGridOverlayEl);
        clearMonthGridOverlay(rsiMonthGridOverlayEl);
        renderVDZones(null);
        renderVDFAnalysisPanel(null);
        setPricePaneMessage(chartContainer, INVALID_SYMBOL_MESSAGE);
        deactivateRsiDivergencePlotTool();
        deactivateVolumeDeltaRsiDivergencePlotTool();
        errorContainer.style.display = "none";
        errorContainer.textContent = "";
        return;
      }
      priceChangeByTime = /* @__PURE__ */ new Map();
      setPricePaneChange(chartContainer, null);
      clearVolumeDeltaDivergenceSummary();
      deactivateRsiDivergencePlotTool();
      deactivateVolumeDeltaRsiDivergencePlotTool();
      errorContainer.style.display = "none";
      errorContainer.textContent = "";
      const retryRender = () => {
        showLoadingOverlay(chartContainer);
        showLoadingOverlay(volumeDeltaRsiContainer);
        showLoadingOverlay(rsiContainer);
        showLoadingOverlay(volumeDeltaContainer);
        renderCustomChart(ticker, interval);
      };
      showRetryOverlay(chartContainer, retryRender);
      showRetryOverlay(volumeDeltaRsiContainer, retryRender);
      showRetryOverlay(rsiContainer, retryRender);
      showRetryOverlay(volumeDeltaContainer, retryRender);
    } finally {
      if (!silent) chartActivelyLoading = false;
      if (chartFetchAbortController === fetchController) {
        chartFetchAbortController = null;
      }
    }
  }
  function syncChartsToPriceRange() {
    if (!priceChart) return;
    const priceRange = priceChart.timeScale().getVisibleLogicalRange();
    if (!priceRange) return;
    try {
      if (volumeDeltaRsiChart) {
        volumeDeltaRsiChart.timeScale().setVisibleLogicalRange(priceRange);
      }
      if (rsiChart) {
        rsiChart.getChart().timeScale().setVisibleLogicalRange(priceRange);
      }
      if (volumeDeltaChart) {
        volumeDeltaChart.timeScale().setVisibleLogicalRange(priceRange);
      }
      scheduleChartLayoutRefresh();
    } catch {
    }
  }
  function applyRightMargin() {
    if (!priceChart) return;
    const rightOffset = RIGHT_MARGIN_BARS;
    priceChart.timeScale().applyOptions({ rightOffset });
    if (volumeDeltaRsiChart) {
      volumeDeltaRsiChart.timeScale().applyOptions({ rightOffset });
    }
    if (rsiChart) {
      rsiChart.getChart().timeScale().applyOptions({ rightOffset });
    }
    if (volumeDeltaChart) {
      volumeDeltaChart.timeScale().applyOptions({ rightOffset });
    }
    scheduleChartLayoutRefresh();
  }
  function applyWeeklyInitialVisibleRange() {
    if (!priceChart) return;
    if (currentChartInterval !== "1week") return;
    if (!Array.isArray(currentBars) || currentBars.length === 0) return;
    const lastIndex = currentBars.length - 1;
    const weeklyBarsToShow = Math.min(currentBars.length, 78);
    const from = Math.max(0, lastIndex - weeklyBarsToShow + 1);
    const to = lastIndex + RIGHT_MARGIN_BARS;
    try {
      priceChart.timeScale().setVisibleLogicalRange({ from, to });
      syncChartsToPriceRange();
      scheduleChartLayoutRefresh();
    } catch {
    }
  }
  function getNearestMappedValueAtOrBefore(time, valuesByTime) {
    const direct = Number(valuesByTime.get(timeKey(time)));
    if (Number.isFinite(direct)) return direct;
    if (!Array.isArray(currentBars) || currentBars.length === 0) return null;
    const targetUnix = toUnixSeconds(time);
    for (let i = currentBars.length - 1; i >= 0; i--) {
      const bar = currentBars[i];
      if (!bar) continue;
      const barTime = bar.time;
      if (targetUnix !== null) {
        const barUnix = toUnixSeconds(barTime);
        if (barUnix !== null && barUnix > targetUnix) continue;
      }
      const candidate = Number(valuesByTime.get(timeKey(barTime)));
      if (Number.isFinite(candidate)) return candidate;
    }
    return null;
  }
  function toggleCrosshairVisibility() {
    crosshairHidden = !crosshairHidden;
    const lineOpts = { visible: !crosshairHidden };
    const opts = { crosshair: { vertLine: lineOpts, horzLine: lineOpts } };
    if (priceChart) priceChart.applyOptions(opts);
    if (volumeDeltaRsiChart) volumeDeltaRsiChart.applyOptions(opts);
    if (volumeDeltaChart) volumeDeltaChart.applyOptions(opts);
    if (rsiChart) rsiChart.getChart()?.applyOptions(opts);
    if (crosshairHidden) {
      priceChart?.clearCrosshairPosition();
      volumeDeltaRsiChart?.clearCrosshairPosition();
      volumeDeltaChart?.clearCrosshairPosition();
      rsiChart?.getChart()?.clearCrosshairPosition();
    }
  }
  function setupChartSync() {
    if (isChartSyncBound) return;
    if (!priceChart || !volumeDeltaRsiChart || !rsiChart || !volumeDeltaChart) return;
    if (!candleSeries || !volumeDeltaRsiSeries || !volumeDeltaHistogramSeries) return;
    isChartSyncBound = true;
    const volumeDeltaRsiChartInstance = volumeDeltaRsiChart;
    const rsiChartInstance = rsiChart.getChart();
    const volumeDeltaChartInstance = volumeDeltaChart;
    let syncLock = null;
    const unlockAfterFrame = (owner) => {
      requestAnimationFrame(() => {
        if (syncLock === owner) syncLock = null;
      });
    };
    const syncRangeFromOwner = (owner, timeRange) => {
      if (!timeRange) return;
      const targets = [
        { owner: "price", chart: priceChart },
        { owner: "volumeDeltaRsi", chart: volumeDeltaRsiChartInstance },
        { owner: "rsi", chart: rsiChartInstance },
        { owner: "volumeDelta", chart: volumeDeltaChartInstance }
      ];
      for (const target of targets) {
        if (target.owner === owner) continue;
        const currentRange = target.chart.timeScale().getVisibleLogicalRange();
        if (!sameLogicalRange(currentRange, timeRange)) {
          target.chart.timeScale().setVisibleLogicalRange(timeRange);
        }
      }
      scheduleChartLayoutRefresh();
    };
    priceChart.timeScale().subscribeVisibleLogicalRangeChange((timeRange) => {
      if (!timeRange || syncLock === "volumeDeltaRsi" || syncLock === "rsi" || syncLock === "volumeDelta") return;
      syncLock = "price";
      try {
        syncRangeFromOwner("price", timeRange);
      } finally {
        unlockAfterFrame("price");
      }
    });
    volumeDeltaRsiChartInstance.timeScale().subscribeVisibleLogicalRangeChange((timeRange) => {
      if (volumeDeltaSuppressSync) return;
      if (!timeRange || syncLock === "price" || syncLock === "rsi" || syncLock === "volumeDelta") return;
      syncLock = "volumeDeltaRsi";
      try {
        syncRangeFromOwner("volumeDeltaRsi", timeRange);
      } finally {
        unlockAfterFrame("volumeDeltaRsi");
      }
    });
    rsiChartInstance.timeScale().subscribeVisibleLogicalRangeChange((timeRange) => {
      if (rsiChart?.isSyncSuppressed?.()) return;
      if (!timeRange || syncLock === "price" || syncLock === "volumeDeltaRsi" || syncLock === "volumeDelta") return;
      syncLock = "rsi";
      try {
        syncRangeFromOwner("rsi", timeRange);
      } finally {
        unlockAfterFrame("rsi");
      }
    });
    volumeDeltaChartInstance.timeScale().subscribeVisibleLogicalRangeChange((timeRange) => {
      if (!timeRange || syncLock === "price" || syncLock === "volumeDeltaRsi" || syncLock === "rsi") return;
      syncLock = "volumeDelta";
      try {
        syncRangeFromOwner("volumeDelta", timeRange);
      } finally {
        unlockAfterFrame("volumeDelta");
      }
    });
    const setCrosshairOnPrice = (time) => {
      const mappedPrice = getNearestMappedValueAtOrBefore(time, priceByTime);
      if (Number.isFinite(mappedPrice) && candleSeries) {
        try {
          priceChart.setCrosshairPosition(Number(mappedPrice), time, candleSeries);
        } catch {
          priceChart.clearCrosshairPosition();
        }
      } else {
        priceChart.clearCrosshairPosition();
      }
    };
    const setCrosshairOnVolumeDeltaRsi = (time) => {
      const mappedVdRsi = getNearestMappedValueAtOrBefore(time, volumeDeltaRsiByTime);
      if (Number.isFinite(mappedVdRsi)) {
        try {
          volumeDeltaRsiChartInstance.setCrosshairPosition(Number(mappedVdRsi), time, volumeDeltaRsiSeries);
        } catch {
          volumeDeltaRsiChartInstance.clearCrosshairPosition();
        }
      } else {
        volumeDeltaRsiChartInstance.clearCrosshairPosition();
      }
    };
    const setCrosshairOnRsi = (time) => {
      const mappedRsi = getNearestMappedValueAtOrBefore(time, rsiByTime);
      const rsiSeries = rsiChart?.getSeries();
      if (Number.isFinite(mappedRsi) && rsiSeries) {
        try {
          rsiChartInstance.setCrosshairPosition(Number(mappedRsi), time, rsiSeries);
        } catch {
          rsiChartInstance.clearCrosshairPosition();
        }
      } else {
        rsiChartInstance.clearCrosshairPosition();
      }
    };
    const setCrosshairOnVolumeDelta = (time) => {
      const mappedVd = getNearestMappedValueAtOrBefore(time, volumeDeltaByTime);
      if (Number.isFinite(mappedVd)) {
        try {
          volumeDeltaChartInstance.setCrosshairPosition(Number(mappedVd), time, volumeDeltaHistogramSeries);
        } catch {
          volumeDeltaChartInstance.clearCrosshairPosition();
        }
      } else {
        volumeDeltaChartInstance.clearCrosshairPosition();
      }
    };
    priceChart.subscribeCrosshairMove((param) => {
      if (!param || !param.time) {
        volumeDeltaRsiChartInstance.clearCrosshairPosition();
        rsiChartInstance.clearCrosshairPosition();
        volumeDeltaChartInstance.clearCrosshairPosition();
        if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, null);
        return;
      }
      if (crosshairHidden) return;
      if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, param.time);
      setCrosshairOnVolumeDeltaRsi(param.time);
      setCrosshairOnRsi(param.time);
      setCrosshairOnVolumeDelta(param.time);
    });
    volumeDeltaRsiChartInstance.subscribeCrosshairMove((param) => {
      if (!param || !param.time) {
        priceChart.clearCrosshairPosition();
        rsiChartInstance.clearCrosshairPosition();
        volumeDeltaChartInstance.clearCrosshairPosition();
        if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, null);
        return;
      }
      if (crosshairHidden) return;
      if (volumeDeltaRsiDivergencePlotToolActive) {
        updateVolumeDeltaRsiDivergencePlotPoint(param.time, true);
      }
      if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, param.time);
      setCrosshairOnPrice(param.time);
      setCrosshairOnRsi(param.time);
      setCrosshairOnVolumeDelta(param.time);
    });
    rsiChartInstance.subscribeCrosshairMove((param) => {
      if (!param || !param.time) {
        priceChart.clearCrosshairPosition();
        volumeDeltaRsiChartInstance.clearCrosshairPosition();
        volumeDeltaChartInstance.clearCrosshairPosition();
        if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, null);
        return;
      }
      if (crosshairHidden) return;
      if (rsiDivergencePlotToolActive) {
        updateRsiDivergencePlotPoint(param.time, true);
      }
      if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, param.time);
      setCrosshairOnPrice(param.time);
      setCrosshairOnVolumeDeltaRsi(param.time);
      setCrosshairOnVolumeDelta(param.time);
    });
    volumeDeltaChartInstance.subscribeCrosshairMove((param) => {
      if (!param || !param.time) {
        priceChart.clearCrosshairPosition();
        volumeDeltaRsiChartInstance.clearCrosshairPosition();
        rsiChartInstance.clearCrosshairPosition();
        if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, null);
        return;
      }
      if (crosshairHidden) return;
      if (pricePaneContainerEl) setPricePaneChange(pricePaneContainerEl, param.time);
      setCrosshairOnPrice(param.time);
      setCrosshairOnVolumeDeltaRsi(param.time);
      setCrosshairOnRsi(param.time);
    });
    rsiChartInstance.subscribeClick((param) => {
      if (!param || !param.time) return;
      if (!rsiDivergencePlotToolActive) return;
      updateRsiDivergencePlotPoint(param.time, false);
    });
    if (isMobileTouch) {
      let lastTapTime = 0;
      const handleDoubleTap = () => {
        const now = Date.now();
        if (now - lastTapTime < 300) {
          toggleCrosshairVisibility();
          lastTapTime = 0;
        } else {
          lastTapTime = now;
        }
      };
      priceChart.subscribeClick(handleDoubleTap);
      volumeDeltaRsiChartInstance.subscribeClick(handleDoubleTap);
      rsiChartInstance.subscribeClick(handleDoubleTap);
      volumeDeltaChartInstance.subscribeClick(handleDoubleTap);
    }
  }
  function initChartControls() {
    const controls = document.getElementById("chart-controls");
    if (!controls) return;
    ensureChartLiveRefreshTimer();
    controls.querySelectorAll("button[data-interval]").forEach((btn) => {
      btn.addEventListener("click", (e2) => {
        const target = e2.currentTarget;
        const interval = target.getAttribute("data-interval");
        if (!interval) return;
        controls.querySelectorAll("button[data-interval]").forEach((b2) => b2.classList.remove("active"));
        target.classList.add("active");
        if (currentChartTicker) {
          scheduleIntervalChartRender(interval);
        }
      });
    });
    controls.querySelectorAll("button[data-mode]").forEach((btn) => {
      btn.addEventListener("click", (e2) => {
        const target = e2.currentTarget;
        const mode = target.getAttribute("data-mode");
        if (!mode) return;
        controls.querySelectorAll("button[data-mode]").forEach((b2) => b2.classList.remove("active"));
        target.classList.add("active");
        if (rsiChart) {
          rsiChart.setDisplayMode(mode);
        }
      });
    });
    initChartFullscreen();
  }
  var FULLSCREEN_ENTER_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="5.5 1 1 1 1 5.5"/>
  <polyline points="10.5 1 15 1 15 5.5"/>
  <polyline points="10.5 15 15 15 15 10.5"/>
  <polyline points="5.5 15 1 15 1 10.5"/>
</svg>`;
  var FULLSCREEN_EXIT_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="1 5.5 5.5 5.5 5.5 1"/>
  <polyline points="15 5.5 10.5 5.5 10.5 1"/>
  <polyline points="15 10.5 10.5 10.5 10.5 15"/>
  <polyline points="1 10.5 5.5 10.5 5.5 15"/>
</svg>`;
  function initChartFullscreen() {
    const btn = document.getElementById("chart-fullscreen-btn");
    const container = document.getElementById("custom-chart-container");
    const navPrevBtn = document.getElementById("chart-nav-prev");
    const navNextBtn = document.getElementById("chart-nav-next");
    if (!btn || !container) return;
    if (navPrevBtn) {
      navPrevBtn.addEventListener("click", () => navigateChart(-1));
    }
    if (navNextBtn) {
      navNextBtn.addEventListener("click", () => navigateChart(1));
    }
    initPaneAxisNavigation();
    const updateIcon = () => {
      const isActive = container.classList.contains("chart-fullscreen");
      btn.innerHTML = isActive ? FULLSCREEN_EXIT_SVG : FULLSCREEN_ENTER_SVG;
      btn.title = isActive ? "Exit fullscreen (Space)" : "Fullscreen (Space)";
      applyPaneScaleVisibilityByPosition();
    };
    const toggleFullscreen = () => {
      container.classList.toggle("chart-fullscreen");
      updateIcon();
    };
    btn.addEventListener("click", toggleFullscreen);
    document.addEventListener("keydown", (e2) => {
      const tickerView = document.getElementById("ticker-view");
      if (!tickerView || tickerView.classList.contains("hidden")) return;
      if (e2.key === "Escape" && container.classList.contains("chart-fullscreen")) {
        container.classList.remove("chart-fullscreen");
        updateIcon();
      }
      if (e2.code === "Space" && document.activeElement?.tagName !== "INPUT") {
        e2.preventDefault();
        toggleFullscreen();
      }
      if (e2.key === "ArrowLeft") {
        navigateChart(-1);
      } else if (e2.key === "ArrowRight") {
        navigateChart(1);
      }
    });
  }
  function navigateChart(direction) {
    const context = getTickerListContext();
    const origin = getTickerOriginView();
    const currentTicker = document.getElementById("ticker-view")?.dataset.ticker;
    if (!context || !currentTicker) return;
    let containerId = "";
    if (origin === "divergence") {
      containerId = context === "daily" ? "divergence-daily-container" : "divergence-weekly-container";
    } else {
      containerId = context === "daily" ? "daily-container" : "weekly-container";
    }
    const container = document.getElementById(containerId);
    if (!container) return;
    const cards = Array.from(container.querySelectorAll(".alert-card"));
    const currentIndex = cards.findIndex((c2) => c2.dataset.ticker === currentTicker);
    if (currentIndex === -1) return;
    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < cards.length) {
      const nextCard = cards[nextIndex];
      const nextTicker = nextCard.dataset.ticker;
      if (nextTicker && window.showTickerView) {
        window.showTickerView(nextTicker, origin, context);
      }
    }
  }
  function initPaneAxisNavigation() {
    const container = document.getElementById("custom-chart-container");
    if (!container) return;
    container.addEventListener("dblclick", (e2) => {
      const rect = container.getBoundingClientRect();
      const x2 = e2.clientX - rect.left;
      const isRightSide = x2 > rect.width - 60;
      if (!isRightSide) return;
      const currentOrder = normalizePaneOrder(paneOrder);
      const pane3Id = currentOrder[2];
      const pane4Id = currentOrder[3];
      const getPaneRect = (id) => {
        const el = document.getElementById(id);
        if (!el || el.style.display === "none") return null;
        return el.getBoundingClientRect();
      };
      const pane3Rect = getPaneRect(pane3Id);
      if (pane3Rect && e2.clientY >= pane3Rect.top && e2.clientY <= pane3Rect.bottom) {
        navigateChart(1);
        return;
      }
      const pane4Rect = getPaneRect(pane4Id);
      if (pane4Rect && e2.clientY >= pane4Rect.top && e2.clientY <= pane4Rect.bottom) {
        navigateChart(-1);
        return;
      }
    });
  }
  function getNeighborTicker(direction) {
    const context = getTickerListContext();
    const origin = getTickerOriginView();
    const currentTicker = document.getElementById("ticker-view")?.dataset.ticker;
    if (!context || !currentTicker) return null;
    let containerId = "";
    if (origin === "divergence") {
      containerId = context === "daily" ? "divergence-daily-container" : "divergence-weekly-container";
    } else {
      containerId = context === "daily" ? "daily-container" : "weekly-container";
    }
    const container = document.getElementById(containerId);
    if (!container) return null;
    const cards = Array.from(container.querySelectorAll(".alert-card"));
    const currentIndex = cards.findIndex((c2) => c2.dataset.ticker === currentTicker);
    if (currentIndex === -1) return null;
    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < cards.length) {
      return cards[nextIndex].dataset.ticker || null;
    }
    return null;
  }
  async function prefetchNeighborTickers(interval, signal) {
    const nextTicker = getNeighborTicker(1);
    const prevTicker = getNeighborTicker(-1);
    const fetchForTicker = async (ticker) => {
      if (signal?.aborted) return;
      const cacheKey = buildChartDataCacheKey(ticker, interval);
      if (getCachedChartData(cacheKey)) return;
      if (chartPrefetchInFlight.has(cacheKey)) return;
      const promise = fetchChartData(ticker, interval, {
        vdRsiLength: volumeDeltaRsiSettings.length,
        vdSourceInterval: volumeDeltaSettings.sourceInterval,
        vdRsiSourceInterval: volumeDeltaRsiSettings.sourceInterval,
        signal
      }).then((data) => setCachedChartData(cacheKey, data)).catch(() => {
      }).finally(() => chartPrefetchInFlight.delete(cacheKey));
      chartPrefetchInFlight.set(cacheKey, promise);
      return promise;
    };
    if (nextTicker) await fetchForTicker(nextTicker);
    if (prevTicker) await fetchForTicker(prevTicker);
  }

  // src/divergenceApi.ts
  function toFavoriteBoolean(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value.toLowerCase() === "true";
    if (typeof value === "number") return value === 1;
    return false;
  }
  function normalizeAlert(raw) {
    const item = raw;
    const id = Number(item.id);
    if (!Number.isFinite(id)) {
      throw new Error("Invalid divergence payload: missing/invalid id");
    }
    return {
      ...item,
      id,
      is_favorite: toFavoriteBoolean(item.is_favorite),
      source: "DataAPI"
    };
  }
  async function fetchDivergenceSignalsFromApi(params = "") {
    try {
      const query = new URLSearchParams(String(params || "").replace(/^\?/, ""));
      query.set("vd_source_interval", getPreferredDivergenceSourceInterval());
      const response = await fetch(`/api/divergence/signals?${query.toString()}`);
      if (!response.ok) throw new Error("Network response was not ok");
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error("Invalid divergence payload: expected array");
      }
      return payload.map(normalizeAlert);
    } catch (error) {
      console.error("Error fetching divergence signals:", error);
      throw error;
    }
  }
  async function toggleDivergenceFavorite(id) {
    const response = await fetch(`/api/divergence/signals/${id}/favorite`, {
      method: "POST"
    });
    if (!response.ok) {
      throw new Error("Network response was not ok");
    }
    return normalizeAlert(await response.json());
  }
  async function startDivergenceFetchDailyData() {
    const response = await fetch("/api/divergence/fetch-daily/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409 && String(payload?.status || "") === "running") {
        return { status: "running" };
      }
      const reason = typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : `Failed to start fetch-daily run (HTTP ${response.status})`;
      throw new Error(reason);
    }
    return { status: String(payload?.status || "started") };
  }
  async function stopDivergenceFetchDailyData() {
    const response = await fetch("/api/divergence/fetch-daily/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409 && typeof payload?.status === "string") {
        return { status: payload.status };
      }
      const reason = typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : `Failed to stop fetch-daily run (HTTP ${response.status})`;
      throw new Error(reason);
    }
    return { status: String(payload?.status || "stop-requested") };
  }
  async function startDivergenceFetchWeeklyData() {
    const response = await fetch("/api/divergence/fetch-weekly/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409 && String(payload?.status || "") === "running") {
        return { status: "running" };
      }
      const reason = typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : `Failed to start fetch-weekly run (HTTP ${response.status})`;
      throw new Error(reason);
    }
    return { status: String(payload?.status || "started") };
  }
  async function stopDivergenceFetchWeeklyData() {
    const response = await fetch("/api/divergence/fetch-weekly/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409 && typeof payload?.status === "string") {
        return { status: payload.status };
      }
      const reason = typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : `Failed to stop fetch-weekly run (HTTP ${response.status})`;
      throw new Error(reason);
    }
    return { status: String(payload?.status || "stop-requested") };
  }
  async function startVDFScan() {
    const response = await fetch("/api/divergence/vdf-scan/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409 && String(payload?.status || "") === "running") {
        return { status: "running" };
      }
      const reason = typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : `Failed to start VDF scan (HTTP ${response.status})`;
      throw new Error(reason);
    }
    return { status: String(payload?.status || "started") };
  }
  async function stopVDFScan() {
    const response = await fetch("/api/divergence/vdf-scan/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 409 && typeof payload?.status === "string") {
        return { status: payload.status };
      }
      const reason = typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : `Failed to stop VDF scan (HTTP ${response.status})`;
      throw new Error(reason);
    }
    return { status: String(payload?.status || "stop-requested") };
  }
  async function fetchDivergenceScanStatus() {
    const response = await fetch("/api/divergence/scan/status");
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) {
      const reason = typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : "Failed to fetch divergence scan status";
      throw new Error(reason);
    }
    return {
      running: Boolean(payload.running),
      lastScanDateEt: payload.lastScanDateEt ?? null,
      scanControl: payload.scanControl ?? null,
      tableBuild: payload.tableBuild ?? null,
      fetchDailyData: payload.fetchDailyData ?? null,
      fetchWeeklyData: payload.fetchWeeklyData ?? null,
      vdfScan: payload.vdfScan ?? null,
      latestJob: payload.latestJob ?? null
    };
  }

  // src/divergenceFeed.ts
  var dailyFeedMode = "1";
  var weeklyFeedMode = "1";
  var dailyCustomFrom = "";
  var dailyCustomTo = "";
  var weeklyCustomFrom = "";
  var weeklyCustomTo = "";
  var dailySortMode = "score";
  var weeklySortMode = "score";
  var dailySortDirection = "desc";
  var weeklySortDirection = "desc";
  var ALERTS_PAGE_SIZE = 100;
  var dailyVisibleCount = ALERTS_PAGE_SIZE;
  var weeklyVisibleCount = ALERTS_PAGE_SIZE;
  var divergenceScanPollTimer = null;
  var divergenceScanPollInFlight = false;
  var divergenceScanPollConsecutiveErrors = 0;
  var DIVERGENCE_POLL_ERROR_THRESHOLD = 3;
  var divergenceFetchDailyLastProcessedTickers = -1;
  var divergenceFetchWeeklyLastProcessedTickers = -1;
  var divergenceTableLastUiRefreshAtMs = 0;
  var DIVERGENCE_TABLE_UI_REFRESH_MIN_MS = 8e3;
  var divergenceTableRunningState = false;
  var divergenceFetchDailyRunningState = false;
  var divergenceFetchWeeklyRunningState = false;
  var allowAutoCardRefreshFromFetchDaily = false;
  var allowAutoCardRefreshFromFetchWeekly = false;
  var allowAutoCardRefreshFromVDFScan = false;
  var vdfScanLastProcessedTickers = -1;
  var miniChartOverlayEl = null;
  var miniChartInstance = null;
  var miniChartHoverTimer = null;
  var miniChartAbortController = null;
  var miniChartCurrentTicker = null;
  var miniChartHoveredCard = null;
  var miniChartDataCache = /* @__PURE__ */ new Map();
  function getColumnFeedMode(column) {
    return column === "daily" ? dailyFeedMode : weeklyFeedMode;
  }
  function setColumnCustomDates(column, from, to) {
    if (column === "daily") {
      dailyCustomFrom = from;
      dailyCustomTo = to;
    } else {
      weeklyCustomFrom = from;
      weeklyCustomTo = to;
    }
  }
  function getColumnCustomDates(column) {
    return column === "daily" ? { from: dailyCustomFrom, to: dailyCustomTo } : { from: weeklyCustomFrom, to: weeklyCustomTo };
  }
  function filterToLatestNDates(alerts, n) {
    const dates = /* @__PURE__ */ new Set();
    for (const a2 of alerts) {
      const d2 = a2.signal_trade_date || (a2.timestamp ? a2.timestamp.slice(0, 10) : null);
      if (d2) dates.add(d2);
    }
    const sorted = [...dates].sort((a2, b2) => b2.localeCompare(a2));
    const topN = new Set(sorted.slice(0, n));
    return alerts.filter((a2) => {
      const d2 = a2.signal_trade_date || (a2.timestamp ? a2.timestamp.slice(0, 10) : null);
      return d2 ? topN.has(d2) : false;
    });
  }
  function applyColumnDateFilter(alerts, mode) {
    if (mode === "1") return filterToLatestNDates(alerts, 1);
    if (mode === "2") return filterToLatestNDates(alerts, 2);
    if (mode === "5") return filterToLatestNDates(alerts, 5);
    return alerts;
  }
  function getRunButtonElements() {
    return {
      button: document.getElementById("divergence-run-btn"),
      status: document.getElementById("divergence-run-status")
    };
  }
  function getTableRunButtonElements() {
    return {
      button: document.getElementById("divergence-run-table-btn"),
      status: document.getElementById("divergence-table-run-status")
    };
  }
  function getFetchDailyButtonElements() {
    return {
      button: document.getElementById("divergence-fetch-daily-btn"),
      status: document.getElementById("divergence-fetch-daily-status")
    };
  }
  function getFetchWeeklyButtonElements() {
    return {
      button: document.getElementById("divergence-fetch-weekly-btn"),
      status: document.getElementById("divergence-fetch-weekly-status")
    };
  }
  function getRunControlButtons() {
    return {
      pauseResumeButton: document.getElementById("divergence-run-pause-resume-btn"),
      stopButton: document.getElementById("divergence-run-stop-btn")
    };
  }
  function getTableControlButtons() {
    return {
      pauseResumeButton: document.getElementById("divergence-table-pause-resume-btn"),
      stopButton: document.getElementById("divergence-table-stop-btn"),
      manualUpdateButton: document.getElementById("divergence-manual-update-btn")
    };
  }
  function getFetchDailyControlButtons() {
    return {
      stopButton: document.getElementById("divergence-fetch-daily-stop-btn")
    };
  }
  function getFetchWeeklyControlButtons() {
    return {
      stopButton: document.getElementById("divergence-fetch-weekly-stop-btn")
    };
  }
  function setRunButtonState(running, canResume = false) {
    const { button } = getRunButtonElements();
    if (!button) return;
    button.disabled = running || canResume;
    button.classList.toggle("active", running);
    button.textContent = running ? "Running" : "Run Fetch";
  }
  function setRunStatusText(text) {
    const { status } = getRunButtonElements();
    if (!status) return;
    status.textContent = text;
  }
  function setTableRunButtonState(running, canResume = false) {
    const { button } = getTableRunButtonElements();
    if (!button) return;
    button.disabled = running || canResume;
    button.classList.toggle("active", running);
    button.textContent = running ? "Running" : "Run Table";
  }
  function setTableRunStatusText(text) {
    const { status } = getTableRunButtonElements();
    if (!status) return;
    status.textContent = text;
  }
  function setFetchDailyButtonState(running, canResume = false) {
    const { button } = getFetchDailyButtonElements();
    if (!button) return;
    button.disabled = running;
    button.classList.toggle("active", running);
    if (canResume && !running) {
      button.textContent = "Resume Fetch";
    } else {
      button.textContent = "Fetch Daily";
    }
  }
  function setFetchDailyStatusText(text) {
    const { status } = getFetchDailyButtonElements();
    if (!status) return;
    status.textContent = text;
  }
  function setFetchWeeklyButtonState(running, canResume = false) {
    const { button } = getFetchWeeklyButtonElements();
    if (!button) return;
    button.disabled = running;
    button.classList.toggle("active", running);
    if (canResume && !running) {
      button.textContent = "Resume Fetch";
    } else {
      button.textContent = "Fetch Weekly";
    }
  }
  function setFetchWeeklyStatusText(text) {
    const { status } = getFetchWeeklyButtonElements();
    if (!status) return;
    status.textContent = text;
  }
  function getVDFScanButtonElements() {
    return {
      button: document.getElementById("divergence-vdf-scan-btn"),
      status: document.getElementById("divergence-vdf-scan-status")
    };
  }
  function getVDFScanControlButtons() {
    return {
      stopButton: document.getElementById("divergence-vdf-scan-stop-btn")
    };
  }
  function setVDFScanButtonState(running) {
    const { button } = getVDFScanButtonElements();
    if (!button) return;
    button.disabled = running;
    button.classList.toggle("active", running);
    button.textContent = "VDF Scan";
  }
  function setVDFScanStatusText(text) {
    const { status } = getVDFScanButtonElements();
    if (!status) return;
    status.textContent = text;
  }
  function setVDFScanControlButtonState(status) {
    const { stopButton } = getVDFScanControlButtons();
    const vdfScan = status?.vdfScan || null;
    const running = Boolean(vdfScan?.running);
    const stopRequested = Boolean(vdfScan?.stop_requested);
    if (stopButton) {
      stopButton.textContent = "\u23F9";
      stopButton.disabled = !running || stopRequested;
      stopButton.classList.toggle("active", running);
      stopButton.setAttribute("aria-label", "Stop VDF Scan");
      stopButton.title = "Stop VDF Scan";
    }
  }
  function setRunControlButtonState(status) {
    const { pauseResumeButton, stopButton } = getRunControlButtons();
    const scan = status?.scanControl || null;
    const running = Boolean(scan?.running || status?.running);
    const pauseRequested = Boolean(scan?.pause_requested);
    const canResume = Boolean(scan?.can_resume);
    const stopRequested = Boolean(scan?.stop_requested);
    if (pauseResumeButton) {
      pauseResumeButton.textContent = canResume && !running ? "\u25B6" : "\u23F8";
      pauseResumeButton.disabled = running ? pauseRequested : !canResume;
      pauseResumeButton.classList.toggle("active", running || canResume);
      pauseResumeButton.setAttribute("aria-label", canResume && !running ? "Resume Run Fetch" : "Pause Run Fetch");
      pauseResumeButton.title = canResume && !running ? "Resume Run Fetch" : "Pause Run Fetch";
    }
    if (stopButton) {
      stopButton.textContent = "\u23F9";
      stopButton.disabled = !running || stopRequested;
      stopButton.classList.toggle("active", running);
      stopButton.setAttribute("aria-label", "Stop Run Fetch");
      stopButton.title = "Stop Run Fetch";
    }
  }
  function setTableControlButtonState(status) {
    const { pauseResumeButton, stopButton, manualUpdateButton } = getTableControlButtons();
    const table = status?.tableBuild || null;
    const running = Boolean(table?.running);
    const pauseRequested = Boolean(table?.pause_requested);
    const stopRequested = Boolean(table?.stop_requested);
    const canResume = Boolean(table?.can_resume);
    if (pauseResumeButton) {
      pauseResumeButton.textContent = canResume && !running ? "\u25B6" : "\u23F8";
      pauseResumeButton.disabled = running ? pauseRequested : !canResume;
      pauseResumeButton.classList.toggle("active", running || canResume);
      pauseResumeButton.setAttribute("aria-label", canResume && !running ? "Resume Run Table" : "Pause Run Table");
      pauseResumeButton.title = canResume && !running ? "Resume Run Table" : "Pause Run Table";
    }
    if (stopButton) {
      stopButton.textContent = "\u23F9";
      stopButton.disabled = !running || stopRequested;
      stopButton.classList.toggle("active", running);
      stopButton.setAttribute("aria-label", "Stop Run Table");
      stopButton.title = "Stop Run Table";
    }
    if (manualUpdateButton) {
      manualUpdateButton.disabled = false;
    }
  }
  function setFetchDailyControlButtonState(status) {
    const { stopButton } = getFetchDailyControlButtons();
    const fetchDaily = status?.fetchDailyData || null;
    const running = Boolean(fetchDaily?.running);
    const stopRequested = Boolean(fetchDaily?.stop_requested);
    if (stopButton) {
      stopButton.textContent = "\u23F9";
      stopButton.disabled = !running || stopRequested;
      stopButton.classList.toggle("active", running);
      stopButton.setAttribute("aria-label", "Stop Fetch Daily");
      stopButton.title = "Stop Fetch Daily";
    }
  }
  function setFetchWeeklyControlButtonState(status) {
    const { stopButton } = getFetchWeeklyControlButtons();
    const fetchWeekly = status?.fetchWeeklyData || null;
    const running = Boolean(fetchWeekly?.running);
    const stopRequested = Boolean(fetchWeekly?.stop_requested);
    if (stopButton) {
      stopButton.textContent = "\u23F9";
      stopButton.disabled = !running || stopRequested;
      stopButton.classList.toggle("active", running);
      stopButton.setAttribute("aria-label", "Stop Fetch Weekly");
      stopButton.title = "Stop Fetch Weekly";
    }
  }
  function toStatusTextFromError(error) {
    const message = String(error?.message || error || "").trim();
    if (!message) return "Run failed";
    if (/not configured/i.test(message)) return "DB not configured";
    if (/unauthorized/i.test(message)) return "Unauthorized";
    if (/already running|running/i.test(message)) return "Already running";
    return message.length > 56 ? `${message.slice(0, 56)}...` : message;
  }
  function toDateKey(raw) {
    const value = String(raw || "").trim();
    if (!value) return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  function toDateKeyAsET(raw) {
    const value = String(raw || "").trim();
    if (!value) return null;
    const d2 = new Date(value);
    if (isNaN(d2.getTime())) return null;
    const parts = d2.toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
    const [mm, dd, yyyy] = parts.split("/");
    if (!mm || !dd || !yyyy) return null;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  function dateKeyToMmDd(dateKey) {
    const parts = dateKey.split("-");
    if (parts.length !== 3) return "";
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!Number.isFinite(month) || month <= 0 || !Number.isFinite(day) || day <= 0) return "";
    return `${month}/${day}`;
  }
  function summarizeLastRunDate(status) {
    const latest = status.latestJob;
    const runDateKey = toDateKey(status.lastScanDateEt) || toDateKey(latest?.scanned_trade_date) || toDateKey(latest?.run_for_date) || toDateKey(latest?.finished_at) || toDateKey(latest?.started_at);
    if (!runDateKey) return "Fetched";
    const mmdd = dateKeyToMmDd(runDateKey);
    return mmdd ? `Fetched ${mmdd}` : "Fetched";
  }
  function summarizeStatus(status) {
    const latest = status.latestJob;
    const scan = status.scanControl || null;
    if (status.running) {
      const processed = Number(latest?.processed_symbols || 0);
      const total = Number(latest?.total_symbols || 0);
      if (scan?.stop_requested) {
        if (total > 0) return `Stopping ${processed}/${total}`;
        return "Stopping";
      }
      if (scan?.pause_requested) {
        if (total > 0) return `Pausing ${processed}/${total}`;
        return "Pausing";
      }
      if (total > 0) return `Running ${processed}/${total}`;
      return "Running";
    }
    if (latest?.status === "paused") {
      const processed = Number(latest?.processed_symbols || 0);
      const total = Number(latest?.total_symbols || 0);
      if (total > 0) return `Paused ${processed}/${total}`;
      return "Paused";
    }
    if (latest?.status === "stopped") {
      return "Stopped";
    }
    if (latest?.status === "completed") {
      return summarizeLastRunDate(status);
    }
    if (latest?.status === "failed") {
      return "Last run failed";
    }
    if (status.lastScanDateEt || latest?.run_for_date || latest?.finished_at || latest?.started_at) {
      return summarizeLastRunDate(status);
    }
    return "Idle";
  }
  function summarizeTableStatus(status) {
    const table = status.tableBuild;
    if (!table) return "Table idle";
    const tableState = String(table.status || "").toLowerCase();
    const errorTickers = Number(table.error_tickers || 0);
    if (tableState === "stopped") {
      return "Table stopped";
    }
    if (tableState === "paused") {
      const processed = Number(table.processed_tickers || 0);
      const total = Number(table.total_tickers || 0);
      if (total > 0) return `Paused ${processed}/${total}`;
      return "Table paused";
    }
    if (table.running) {
      const processed = Number(table.processed_tickers || 0);
      const total = Number(table.total_tickers || 0);
      if (table.stop_requested) {
        if (total > 0) return `Stopping ${processed}/${total}`;
        return "Stopping";
      }
      if (table.pause_requested) {
        if (total > 0) return `Pausing ${processed}/${total}`;
        return "Pausing";
      }
      if (total > 0) return `Table ${processed}/${total}`;
      return "Table running";
    }
    if (tableState === "completed") {
      const dateKey = toDateKey(table.last_published_trade_date || null);
      const mmdd = dateKey ? dateKeyToMmDd(dateKey) : "";
      return mmdd ? `Table ${mmdd}` : "Table fetched";
    }
    if (tableState === "completed-with-errors") {
      const dateKey = toDateKey(table.last_published_trade_date || null);
      const mmdd = dateKey ? dateKeyToMmDd(dateKey) : "";
      if (mmdd && errorTickers > 0) return `Table ${mmdd} (${errorTickers} errors)`;
      if (errorTickers > 0) return `Table done (${errorTickers} errors)`;
      return mmdd ? `Table ${mmdd}` : "Table fetched";
    }
    if (tableState === "failed") {
      return "Table failed";
    }
    return "Table idle";
  }
  function summarizeFetchDailyStatus(status) {
    const fetchDaily = status.fetchDailyData;
    const latest = status.latestJob;
    const lastRunDateKey = toDateKey(fetchDaily?.last_published_trade_date || null) || toDateKey(status.lastScanDateEt) || toDateKey(latest?.scanned_trade_date) || toDateKey(latest?.run_for_date) || toDateKey(latest?.finished_at) || toDateKey(latest?.started_at);
    const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : "";
    const ranText = lastRunMmDd ? `Fetched ${lastRunMmDd}` : "Fetched --";
    if (!fetchDaily) return ranText;
    const fetchDailyState = String(fetchDaily.status || "").toLowerCase();
    if (fetchDailyState === "stopping") {
      return "Stopping";
    }
    if (fetchDailyState === "stopped") {
      if (fetchDaily.can_resume) {
        const processed = Number(fetchDaily.processed_tickers || 0);
        const total = Number(fetchDaily.total_tickers || 0);
        return total > 0 ? `Stopped ${processed}/${total} (resumable)` : "Stopped (resumable)";
      }
      return "Stopped";
    }
    if (fetchDaily.running) {
      const processed = Number(fetchDaily.processed_tickers || 0);
      const total = Number(fetchDaily.total_tickers || 0);
      const errors = Number(fetchDaily.error_tickers || 0);
      if (fetchDaily.stop_requested) {
        return "Stopping";
      }
      if (fetchDailyState === "running-retry") {
        return `Retrying ${errors} failed (${processed}/${total})`;
      }
      if (fetchDailyState === "running-ma") {
        return `MA ${processed}/${total}`;
      }
      if (fetchDailyState === "running-ma-retry") {
        return `Retrying failed MA (${processed}/${total})`;
      }
      return `${processed} / ${total}`;
    }
    if (fetchDailyState === "completed") {
      return ranText;
    }
    if (fetchDailyState === "completed-with-errors") {
      return ranText;
    }
    if (fetchDailyState === "failed") {
      return ranText;
    }
    return ranText;
  }
  function summarizeFetchWeeklyStatus(status) {
    const fetchWeekly = status.fetchWeeklyData;
    const latest = status.latestJob;
    const lastRunDateKey = toDateKey(fetchWeekly?.last_published_trade_date || null) || toDateKey(status.lastScanDateEt) || toDateKey(latest?.scanned_trade_date) || toDateKey(latest?.run_for_date) || toDateKey(latest?.finished_at) || toDateKey(latest?.started_at);
    const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : "";
    const ranText = lastRunMmDd ? `Fetched ${lastRunMmDd}` : "Fetched --";
    if (!fetchWeekly) return ranText;
    const fetchWeeklyState = String(fetchWeekly.status || "").toLowerCase();
    if (fetchWeeklyState === "stopping") {
      return "Stopping";
    }
    if (fetchWeeklyState === "stopped") {
      if (fetchWeekly.can_resume) {
        const processed = Number(fetchWeekly.processed_tickers || 0);
        const total = Number(fetchWeekly.total_tickers || 0);
        return total > 0 ? `Stopped ${processed}/${total} (resumable)` : "Stopped (resumable)";
      }
      return "Stopped";
    }
    if (fetchWeekly.running) {
      const processed = Number(fetchWeekly.processed_tickers || 0);
      const total = Number(fetchWeekly.total_tickers || 0);
      const errors = Number(fetchWeekly.error_tickers || 0);
      if (fetchWeekly.stop_requested) {
        return "Stopping";
      }
      if (fetchWeeklyState === "running-retry") {
        return `Retrying ${errors} failed (${processed}/${total})`;
      }
      if (fetchWeeklyState === "running-ma") {
        return `MA ${processed}/${total}`;
      }
      if (fetchWeeklyState === "running-ma-retry") {
        return `Retrying failed MA (${processed}/${total})`;
      }
      return `${processed} / ${total}`;
    }
    if (fetchWeeklyState === "completed") {
      return ranText;
    }
    if (fetchWeeklyState === "completed-with-errors") {
      return ranText;
    }
    if (fetchWeeklyState === "failed") {
      return ranText;
    }
    return ranText;
  }
  function summarizeVDFScanStatus(status) {
    const scan = status.vdfScan;
    if (!scan) return "Ran --";
    const state = String(scan.status || "").toLowerCase();
    const lastRunDateKey = toDateKeyAsET(scan.finished_at || scan.started_at || null);
    const lastRunMmDd = lastRunDateKey ? dateKeyToMmDd(lastRunDateKey) : "";
    const ranText = lastRunMmDd ? `Ran ${lastRunMmDd}` : "Ran --";
    if (state === "stopping") {
      return "Stopping";
    }
    if (state === "stopped") {
      return "Stopped";
    }
    if (scan.running) {
      const processed = Number(scan.processed_tickers || 0);
      const total = Number(scan.total_tickers || 0);
      const detected = Number(scan.detected_tickers || 0);
      if (scan.stop_requested) {
        return "Stopping";
      }
      if (state === "running-retry") {
        return `Retrying (${processed}/${total})`;
      }
      return `${processed}/${total} (${detected} VDF)`;
    }
    if (state === "completed" || state === "completed-with-errors") {
      const detected = Number(scan.detected_tickers || 0);
      return detected > 0 ? `${ranText} (${detected} VDF)` : ranText;
    }
    if (state === "failed") {
      return ranText;
    }
    return ranText;
  }
  function clearDivergenceScanPolling() {
    if (divergenceScanPollTimer !== null) {
      window.clearInterval(divergenceScanPollTimer);
      divergenceScanPollTimer = null;
    }
  }
  function refreshDivergenceCardsWhileRunning(force = false, timeframe) {
    if (isChartActivelyLoading()) return;
    const nowMs = Date.now();
    if (!force && nowMs - divergenceTableLastUiRefreshAtMs < DIVERGENCE_TABLE_UI_REFRESH_MIN_MS) {
      return;
    }
    divergenceTableLastUiRefreshAtMs = nowMs;
    if (timeframe) {
      void fetchDivergenceSignalsByTimeframe(timeframe).then(() => renderDivergenceContainer(timeframe)).catch(() => {
      });
    } else {
      void fetchDivergenceSignals().then(renderDivergenceOverview).catch(() => {
      });
    }
  }
  async function pollDivergenceScanStatus(refreshOnComplete) {
    if (divergenceScanPollInFlight) return;
    divergenceScanPollInFlight = true;
    try {
      const status = await fetchDivergenceScanStatus();
      divergenceScanPollConsecutiveErrors = 0;
      divergenceTableRunningState = Boolean(status.tableBuild?.running);
      divergenceFetchDailyRunningState = Boolean(status.fetchDailyData?.running);
      divergenceFetchWeeklyRunningState = Boolean(status.fetchWeeklyData?.running);
      setRunButtonState(status.running, Boolean(status.scanControl?.can_resume));
      setRunStatusText(summarizeStatus(status));
      setRunControlButtonState(status);
      const tableRunning = divergenceTableRunningState;
      setTableRunButtonState(tableRunning, Boolean(status.tableBuild?.can_resume));
      setTableRunStatusText(summarizeTableStatus(status));
      setTableControlButtonState(status);
      const fetchDailyRunning = divergenceFetchDailyRunningState;
      const fetchDailyCanResume = Boolean(status.fetchDailyData?.can_resume);
      setFetchDailyButtonState(fetchDailyRunning, fetchDailyCanResume);
      setFetchDailyStatusText(summarizeFetchDailyStatus(status));
      setFetchDailyControlButtonState(status);
      const fetchWeeklyRunning = divergenceFetchWeeklyRunningState;
      const fetchWeeklyCanResume = Boolean(status.fetchWeeklyData?.can_resume);
      setFetchWeeklyButtonState(fetchWeeklyRunning, fetchWeeklyCanResume);
      setFetchWeeklyStatusText(summarizeFetchWeeklyStatus(status));
      setFetchWeeklyControlButtonState(status);
      const vdfRunning1 = Boolean(status.vdfScan?.running);
      setVDFScanButtonState(vdfRunning1);
      setVDFScanStatusText(summarizeVDFScanStatus(status));
      setVDFScanControlButtonState(status);
      if (fetchDailyRunning) {
        allowAutoCardRefreshFromFetchDaily = true;
        allowAutoCardRefreshFromFetchWeekly = false;
      } else if (fetchWeeklyRunning) {
        allowAutoCardRefreshFromFetchWeekly = true;
        allowAutoCardRefreshFromFetchDaily = false;
      }
      if (fetchDailyRunning && allowAutoCardRefreshFromFetchDaily) {
        const processed = Number(status.fetchDailyData?.processed_tickers || 0);
        const progressed = processed !== divergenceFetchDailyLastProcessedTickers;
        divergenceFetchDailyLastProcessedTickers = processed;
        refreshDivergenceCardsWhileRunning(progressed, "1d");
      } else {
        divergenceFetchDailyLastProcessedTickers = -1;
      }
      if (fetchWeeklyRunning && allowAutoCardRefreshFromFetchWeekly) {
        const processed = Number(status.fetchWeeklyData?.processed_tickers || 0);
        const progressed = processed !== divergenceFetchWeeklyLastProcessedTickers;
        divergenceFetchWeeklyLastProcessedTickers = processed;
        refreshDivergenceCardsWhileRunning(progressed, "1w");
      } else {
        divergenceFetchWeeklyLastProcessedTickers = -1;
      }
      if (vdfRunning1 && allowAutoCardRefreshFromVDFScan) {
        const processed = Number(status.vdfScan?.processed_tickers || 0);
        const progressed = processed !== vdfScanLastProcessedTickers;
        vdfScanLastProcessedTickers = processed;
        if (progressed) {
          refreshDivergenceCardsWhileRunning(true);
        }
      } else {
        vdfScanLastProcessedTickers = -1;
      }
      if (!fetchDailyRunning && !fetchWeeklyRunning && !vdfRunning1) {
        divergenceTableLastUiRefreshAtMs = 0;
      }
      if (!status.running && !tableRunning && !fetchDailyRunning && !fetchWeeklyRunning && !vdfRunning1) {
        clearDivergenceScanPolling();
        if (refreshOnComplete) {
          if (allowAutoCardRefreshFromFetchDaily) {
            await fetchDivergenceSignalsByTimeframe("1d");
            renderDivergenceContainer("1d");
          }
          if (allowAutoCardRefreshFromFetchWeekly) {
            await fetchDivergenceSignalsByTimeframe("1w");
            renderDivergenceContainer("1w");
          }
          if (allowAutoCardRefreshFromVDFScan) {
            await fetchDivergenceSignals();
            renderDivergenceOverview();
          }
        }
        allowAutoCardRefreshFromFetchDaily = false;
        allowAutoCardRefreshFromFetchWeekly = false;
        allowAutoCardRefreshFromVDFScan = false;
      }
    } catch (error) {
      divergenceScanPollConsecutiveErrors += 1;
      if (divergenceScanPollConsecutiveErrors < DIVERGENCE_POLL_ERROR_THRESHOLD) {
        console.warn(`Scan status poll failed (${divergenceScanPollConsecutiveErrors}/${DIVERGENCE_POLL_ERROR_THRESHOLD}), retrying next cycle`);
      } else {
        console.error("Failed to poll divergence scan status:", error);
        divergenceTableRunningState = false;
        divergenceFetchDailyRunningState = false;
        divergenceFetchWeeklyRunningState = false;
        setRunStatusText(toStatusTextFromError(error));
        setTableRunStatusText(toStatusTextFromError(error));
        setFetchDailyStatusText(toStatusTextFromError(error));
        setFetchWeeklyStatusText(toStatusTextFromError(error));
        clearDivergenceScanPolling();
        setRunButtonState(false, false);
        setRunControlButtonState(null);
        setTableRunButtonState(false, false);
        setTableControlButtonState(null);
        setFetchDailyButtonState(false, false);
        setFetchDailyControlButtonState(null);
        setFetchWeeklyButtonState(false, false);
        setFetchWeeklyControlButtonState(null);
        setVDFScanButtonState(false);
        setVDFScanControlButtonState(null);
        allowAutoCardRefreshFromFetchDaily = false;
        allowAutoCardRefreshFromFetchWeekly = false;
      }
    } finally {
      divergenceScanPollInFlight = false;
    }
  }
  function ensureDivergenceScanPolling(refreshOnComplete) {
    clearDivergenceScanPolling();
    divergenceScanPollTimer = window.setInterval(() => {
      pollDivergenceScanStatus(refreshOnComplete);
    }, 2500);
  }
  async function syncDivergenceScanUiState() {
    try {
      const status = await fetchDivergenceScanStatus();
      divergenceTableRunningState = Boolean(status.tableBuild?.running);
      divergenceFetchDailyRunningState = Boolean(status.fetchDailyData?.running);
      divergenceFetchWeeklyRunningState = Boolean(status.fetchWeeklyData?.running);
      setRunButtonState(status.running, Boolean(status.scanControl?.can_resume));
      setRunStatusText(summarizeStatus(status));
      setRunControlButtonState(status);
      const tableRunning = divergenceTableRunningState;
      setTableRunButtonState(tableRunning, Boolean(status.tableBuild?.can_resume));
      setTableRunStatusText(summarizeTableStatus(status));
      setTableControlButtonState(status);
      const fetchDailyRunning = divergenceFetchDailyRunningState;
      const fetchDailyCanResume = Boolean(status.fetchDailyData?.can_resume);
      setFetchDailyButtonState(fetchDailyRunning, fetchDailyCanResume);
      setFetchDailyStatusText(summarizeFetchDailyStatus(status));
      setFetchDailyControlButtonState(status);
      const fetchWeeklyRunning = divergenceFetchWeeklyRunningState;
      const fetchWeeklyCanResume = Boolean(status.fetchWeeklyData?.can_resume);
      setFetchWeeklyButtonState(fetchWeeklyRunning, fetchWeeklyCanResume);
      setFetchWeeklyStatusText(summarizeFetchWeeklyStatus(status));
      setFetchWeeklyControlButtonState(status);
      const vdfRunning2 = Boolean(status.vdfScan?.running);
      setVDFScanButtonState(vdfRunning2);
      setVDFScanStatusText(summarizeVDFScanStatus(status));
      setVDFScanControlButtonState(status);
      if (fetchDailyRunning) {
        allowAutoCardRefreshFromFetchDaily = true;
        allowAutoCardRefreshFromFetchWeekly = false;
      } else if (fetchWeeklyRunning) {
        allowAutoCardRefreshFromFetchWeekly = true;
        allowAutoCardRefreshFromFetchDaily = false;
      }
      if (fetchDailyRunning && allowAutoCardRefreshFromFetchDaily) {
        const processed = Number(status.fetchDailyData?.processed_tickers || 0);
        const progressed = processed !== divergenceFetchDailyLastProcessedTickers;
        divergenceFetchDailyLastProcessedTickers = processed;
        refreshDivergenceCardsWhileRunning(progressed, "1d");
      } else {
        divergenceFetchDailyLastProcessedTickers = -1;
      }
      if (fetchWeeklyRunning && allowAutoCardRefreshFromFetchWeekly) {
        const processed = Number(status.fetchWeeklyData?.processed_tickers || 0);
        const progressed = processed !== divergenceFetchWeeklyLastProcessedTickers;
        divergenceFetchWeeklyLastProcessedTickers = processed;
        refreshDivergenceCardsWhileRunning(progressed, "1w");
      } else {
        divergenceFetchWeeklyLastProcessedTickers = -1;
      }
      if (!fetchDailyRunning && !fetchWeeklyRunning) {
        divergenceTableLastUiRefreshAtMs = 0;
      }
      if (status.running || tableRunning || fetchDailyRunning || fetchWeeklyRunning || vdfRunning2) {
        ensureDivergenceScanPolling(true);
      } else {
        clearDivergenceScanPolling();
        allowAutoCardRefreshFromFetchDaily = false;
        allowAutoCardRefreshFromFetchWeekly = false;
      }
    } catch (error) {
      console.error("Failed to sync divergence scan UI state:", error);
      divergenceTableRunningState = false;
      divergenceFetchDailyRunningState = false;
      divergenceFetchWeeklyRunningState = false;
      setRunButtonState(false, false);
      setRunControlButtonState(null);
      setRunStatusText(toStatusTextFromError(error));
      setTableRunButtonState(false, false);
      setTableRunStatusText(toStatusTextFromError(error));
      setTableControlButtonState(null);
      setFetchDailyButtonState(false, false);
      setFetchDailyStatusText(toStatusTextFromError(error));
      setFetchDailyControlButtonState(null);
      setFetchWeeklyButtonState(false, false);
      setFetchWeeklyStatusText(toStatusTextFromError(error));
      setFetchWeeklyControlButtonState(null);
      setVDFScanButtonState(false);
      setVDFScanControlButtonState(null);
      allowAutoCardRefreshFromFetchDaily = false;
      allowAutoCardRefreshFromFetchWeekly = false;
    }
  }
  async function runManualDivergenceFetchDailyData() {
    setFetchDailyButtonState(true);
    setFetchDailyStatusText("Starting...");
    allowAutoCardRefreshFromFetchDaily = true;
    allowAutoCardRefreshFromFetchWeekly = false;
    try {
      const started = await startDivergenceFetchDailyData();
      if (started.status === "running") setFetchDailyStatusText("Already running");
      else if (started.status === "resumed") setFetchDailyStatusText("Resuming...");
      ensureDivergenceScanPolling(true);
      await pollDivergenceScanStatus(false);
    } catch (error) {
      console.error("Failed to start fetch-daily run:", error);
      setFetchDailyButtonState(false);
      setFetchDailyStatusText(toStatusTextFromError(error));
    }
  }
  async function runManualDivergenceFetchWeeklyData() {
    setFetchWeeklyButtonState(true);
    setFetchWeeklyStatusText("Starting...");
    allowAutoCardRefreshFromFetchWeekly = true;
    allowAutoCardRefreshFromFetchDaily = false;
    try {
      const started = await startDivergenceFetchWeeklyData();
      if (started.status === "running") setFetchWeeklyStatusText("Already running");
      else if (started.status === "resumed") setFetchWeeklyStatusText("Resuming...");
      ensureDivergenceScanPolling(true);
      await pollDivergenceScanStatus(false);
    } catch (error) {
      console.error("Failed to start fetch-weekly run:", error);
      setFetchWeeklyButtonState(false);
      setFetchWeeklyStatusText(toStatusTextFromError(error));
    }
  }
  async function stopManualDivergenceFetchDailyData() {
    try {
      const result = await stopDivergenceFetchDailyData();
      if (result.status === "stop-requested") {
        setFetchDailyStatusText("Stopping");
      }
      allowAutoCardRefreshFromFetchDaily = false;
      await syncDivergenceScanUiState();
    } catch (error) {
      console.error("Failed to stop fetch-daily run:", error);
      setFetchDailyStatusText(toStatusTextFromError(error));
    }
  }
  async function stopManualDivergenceFetchWeeklyData() {
    try {
      const result = await stopDivergenceFetchWeeklyData();
      if (result.status === "stop-requested") {
        setFetchWeeklyStatusText("Stopping");
      }
      allowAutoCardRefreshFromFetchWeekly = false;
      await syncDivergenceScanUiState();
    } catch (error) {
      console.error("Failed to stop fetch-weekly run:", error);
      setFetchWeeklyStatusText(toStatusTextFromError(error));
    }
  }
  async function runManualVDFScan() {
    setVDFScanButtonState(true);
    setVDFScanStatusText("Starting...");
    allowAutoCardRefreshFromVDFScan = true;
    allowAutoCardRefreshFromFetchDaily = false;
    allowAutoCardRefreshFromFetchWeekly = false;
    try {
      const started = await startVDFScan();
      if (started.status === "running") setVDFScanStatusText("Already running");
      ensureDivergenceScanPolling(true);
      await pollDivergenceScanStatus(false);
    } catch (error) {
      console.error("Failed to start VDF scan:", error);
      setVDFScanButtonState(false);
      setVDFScanStatusText(toStatusTextFromError(error));
    }
  }
  async function stopManualVDFScan() {
    try {
      const result = await stopVDFScan();
      if (result.status === "stop-requested") {
        setVDFScanStatusText("Stopping");
      }
      allowAutoCardRefreshFromVDFScan = false;
      await syncDivergenceScanUiState();
    } catch (error) {
      console.error("Failed to stop VDF scan:", error);
      setVDFScanStatusText(toStatusTextFromError(error));
    }
  }
  async function fetchDivergenceSignals(_force) {
    try {
      const [daily, weekly] = await Promise.all([
        fetchDivergenceSignalsByTimeframe("1d"),
        fetchDivergenceSignalsByTimeframe("1w")
      ]);
      const all = [...daily, ...weekly];
      primeDivergenceSummaryCacheFromAlerts(all);
      return all;
    } catch (error) {
      console.error("Error fetching divergence signals:", error);
      return [];
    }
  }
  function showMoreButtonHtml(shown, total, timeframe) {
    if (shown >= total) return "";
    const remaining = total - shown;
    const nextBatch = Math.min(remaining, ALERTS_PAGE_SIZE);
    return `<button class="tf-btn show-more-btn" data-timeframe="${timeframe}">\u25BC Show ${nextBatch} more (${shown}/${total})</button>`;
  }
  function renderDivergenceOverview() {
    const allSignals = getDivergenceSignals();
    primeDivergenceSummaryCacheFromAlerts(allSignals);
    dailyVisibleCount = ALERTS_PAGE_SIZE;
    weeklyVisibleCount = ALERTS_PAGE_SIZE;
    const dailyContainer = document.getElementById("divergence-daily-container");
    const weeklyContainer = document.getElementById("divergence-weekly-container");
    if (!dailyContainer || !weeklyContainer) return;
    let daily = allSignals.filter((a2) => (a2.timeframe || "").trim() === "1d");
    let weekly = allSignals.filter((a2) => (a2.timeframe || "").trim() === "1w");
    daily = applyColumnDateFilter(daily, dailyFeedMode);
    weekly = applyColumnDateFilter(weekly, weeklyFeedMode);
    if (dailySortMode === "favorite") {
      daily = daily.filter((a2) => a2.is_favorite);
    }
    if (weeklySortMode === "favorite") {
      weekly = weekly.filter((a2) => a2.is_favorite);
    }
    daily.sort(createAlertSortFn(dailySortMode === "favorite" ? "time" : dailySortMode, dailySortDirection));
    weekly.sort(createAlertSortFn(weeklySortMode === "favorite" ? "time" : weeklySortMode, weeklySortDirection));
    const dailySlice = daily.slice(0, dailyVisibleCount);
    const weeklySlice = weekly.slice(0, weeklyVisibleCount);
    dailyContainer.innerHTML = dailySlice.map(createAlertCard).join("") + showMoreButtonHtml(dailySlice.length, daily.length, "1d");
    weeklyContainer.innerHTML = weeklySlice.map(createAlertCard).join("") + showMoreButtonHtml(weeklySlice.length, weekly.length, "1w");
    renderAlertCardDivergenceTablesFromCache(dailyContainer);
    renderAlertCardDivergenceTablesFromCache(weeklyContainer);
  }
  async function fetchDivergenceSignalsByTimeframe(timeframe) {
    try {
      const column = timeframe === "1d" ? "daily" : "weekly";
      const mode = getColumnFeedMode(column);
      const custom = getColumnCustomDates(column);
      const { startDate, endDate } = getDateRangeForMode(mode, custom.from, custom.to);
      if (!startDate || !endDate) return [];
      const params = `?start_date=${startDate}&end_date=${endDate}&timeframe=${timeframe}`;
      const data = await fetchDivergenceSignalsFromApi(params);
      primeDivergenceSummaryCacheFromAlerts(data);
      setDivergenceSignalsByTimeframe(timeframe, data);
      return data;
    } catch (error) {
      console.error(`Error fetching divergence signals for ${timeframe}:`, error);
      return [];
    }
  }
  function renderDivergenceContainer(timeframe) {
    const allSignals = getDivergenceSignals();
    const containerId = timeframe === "1d" ? "divergence-daily-container" : "divergence-weekly-container";
    const container = document.getElementById(containerId);
    if (!container) return;
    const column = timeframe === "1d" ? "daily" : "weekly";
    const mode = getColumnFeedMode(column);
    const sortMode = timeframe === "1d" ? dailySortMode : weeklySortMode;
    const sortDirection = timeframe === "1d" ? dailySortDirection : weeklySortDirection;
    let signals = allSignals.filter((a2) => (a2.timeframe || "").trim() === timeframe);
    signals = applyColumnDateFilter(signals, mode);
    if (sortMode === "favorite") {
      signals = signals.filter((a2) => a2.is_favorite);
    }
    signals.sort(createAlertSortFn(sortMode === "favorite" ? "time" : sortMode, sortDirection));
    const visibleCount = timeframe === "1d" ? dailyVisibleCount : weeklyVisibleCount;
    const slice = signals.slice(0, visibleCount);
    container.innerHTML = slice.map(createAlertCard).join("") + showMoreButtonHtml(slice.length, signals.length, timeframe);
    renderAlertCardDivergenceTablesFromCache(container);
  }
  function destroyMiniChartOverlay() {
    if (miniChartHoverTimer !== null) {
      window.clearTimeout(miniChartHoverTimer);
      miniChartHoverTimer = null;
    }
    if (miniChartAbortController) {
      try {
        miniChartAbortController.abort();
      } catch {
      }
      miniChartAbortController = null;
    }
    if (miniChartInstance) {
      try {
        miniChartInstance.remove();
      } catch {
      }
      miniChartInstance = null;
    }
    if (miniChartOverlayEl) {
      miniChartOverlayEl.remove();
      miniChartOverlayEl = null;
    }
    miniChartCurrentTicker = null;
    miniChartHoveredCard = null;
  }
  async function showMiniChartOverlay(ticker, cardRect) {
    if (miniChartCurrentTicker === ticker && miniChartOverlayEl) return;
    destroyMiniChartOverlay();
    miniChartCurrentTicker = ticker;
    const overlay = document.createElement("div");
    overlay.className = "mini-chart-overlay";
    overlay.style.cssText = `
        position: fixed;
        width: 500px;
        height: 300px;
        background: #0d1117;
        border: 1px solid #30363d;
        border-radius: 6px;
        z-index: 1000;
        pointer-events: none;
        overflow: hidden;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    `;
    const OVERLAY_W = 500;
    const OVERLAY_H = 300;
    const GAP = 8;
    let left = cardRect.right + GAP;
    let top = cardRect.top;
    if (left + OVERLAY_W > window.innerWidth) {
      left = cardRect.left - OVERLAY_W - GAP;
    }
    if (left < 0) left = GAP;
    if (top + OVERLAY_H > window.innerHeight) {
      top = window.innerHeight - OVERLAY_H - GAP;
    }
    if (top < 0) top = GAP;
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    document.body.appendChild(overlay);
    miniChartOverlayEl = overlay;
    let bars;
    const cached = miniChartDataCache.get(ticker);
    if (cached) {
      bars = cached;
    } else {
      const controller = new AbortController();
      miniChartAbortController = controller;
      try {
        const res = await fetch(`/api/chart/mini-bars?ticker=${encodeURIComponent(ticker)}`, {
          signal: controller.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        bars = Array.isArray(data?.bars) ? data.bars : [];
        if (bars.length > 0) miniChartDataCache.set(ticker, bars);
      } catch {
        if (miniChartCurrentTicker === ticker) destroyMiniChartOverlay();
        return;
      }
      miniChartAbortController = null;
    }
    if (miniChartCurrentTicker !== ticker || !miniChartOverlayEl) return;
    if (bars.length === 0) {
      destroyMiniChartOverlay();
      return;
    }
    const chart = Ve(overlay, {
      width: 500,
      height: 300,
      layout: {
        background: { color: "#0d1117" },
        textColor: "#d1d4dc",
        fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
        attributionLogo: false
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      handleScroll: false,
      handleScale: false,
      crosshair: {
        vertLine: { visible: false },
        horzLine: { visible: false }
      }
    });
    miniChartInstance = chart;
    const candleSeries2 = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      priceLineVisible: false,
      lastValueVisible: false
    });
    candleSeries2.setData(bars);
    chart.timeScale().fitContent();
  }
  function handleFavoriteClick(e2) {
    const target = e2.target;
    const starBtn = target.closest(".fav-icon");
    if (!starBtn) return;
    e2.stopPropagation();
    const id = starBtn.dataset.id;
    const source = "DataAPI";
    if (!id) return;
    const allStars = document.querySelectorAll(`.fav-icon[data-id="${id}"][data-source="${source}"]`);
    const isCurrentlyFilled = starBtn.classList.contains("filled");
    allStars.forEach((star) => {
      const checkmark = star.querySelector(".check-mark");
      if (!isCurrentlyFilled) {
        star.classList.add("filled");
        if (checkmark) {
          checkmark.style.visibility = "visible";
          checkmark.style.opacity = "1";
        }
      } else {
        star.classList.remove("filled");
        if (checkmark) {
          checkmark.style.visibility = "hidden";
          checkmark.style.opacity = "0";
        }
      }
    });
    toggleDivergenceFavorite(Number(id)).then((updatedAlert) => {
      const all = getDivergenceSignals();
      const idx = all.findIndex((a2) => a2.id === updatedAlert.id);
      if (idx !== -1) {
        all[idx].is_favorite = updatedAlert.is_favorite;
        setDivergenceSignals(all);
      }
      allStars.forEach((star) => {
        const checkmark = star.querySelector(".check-mark");
        if (updatedAlert.is_favorite) {
          star.classList.add("filled");
          if (checkmark) {
            checkmark.style.visibility = "visible";
            checkmark.style.opacity = "1";
          }
        } else {
          star.classList.remove("filled");
          if (checkmark) {
            checkmark.style.visibility = "hidden";
            checkmark.style.opacity = "0";
          }
        }
      });
    }).catch(() => {
      allStars.forEach((star) => {
        const checkmark = star.querySelector(".check-mark");
        if (isCurrentlyFilled) {
          star.classList.add("filled");
          if (checkmark) {
            checkmark.style.visibility = "visible";
            checkmark.style.opacity = "1";
          }
        } else {
          star.classList.remove("filled");
          if (checkmark) {
            checkmark.style.visibility = "hidden";
            checkmark.style.opacity = "0";
          }
        }
      });
    });
  }
  function setupDivergenceFeedDelegation() {
    const view = document.getElementById("view-divergence");
    if (!view) return;
    view.addEventListener("click", handleFavoriteClick);
    const tickerView = document.getElementById("ticker-view");
    if (tickerView) {
      tickerView.addEventListener("click", handleFavoriteClick);
    }
    view.addEventListener("click", (e2) => {
      const target = e2.target;
      if (target.closest(".fav-icon")) return;
      const card = target.closest(".alert-card");
      if (card) {
        const ticker = card.dataset.ticker;
        if (ticker && window.showTickerView) {
          let listContext = null;
          if (card.closest("#divergence-daily-container")) {
            listContext = "daily";
          } else if (card.closest("#divergence-weekly-container")) {
            listContext = "weekly";
          }
          window.showTickerView(ticker, "divergence", listContext);
        }
      }
    });
    document.querySelectorAll("#view-divergence .divergence-daily-sort .tf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.sort;
        setDivergenceDailySort(mode);
      });
    });
    document.querySelectorAll("#view-divergence .divergence-weekly-sort .tf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.sort;
        setDivergenceWeeklySort(mode);
      });
    });
    view.addEventListener("mouseenter", (e2) => {
      const me2 = e2;
      const target = me2.target;
      const card = target.closest(".alert-card");
      if (!card) return;
      const ticker = card.dataset.ticker;
      if (!ticker) return;
      if (miniChartHoveredCard === card) return;
      miniChartHoveredCard = card;
      if (miniChartHoverTimer !== null) {
        window.clearTimeout(miniChartHoverTimer);
      }
      miniChartHoverTimer = window.setTimeout(() => {
        miniChartHoverTimer = null;
        const rect = card.getBoundingClientRect();
        showMiniChartOverlay(ticker, rect);
      }, 1e3);
    }, true);
    view.addEventListener("mouseleave", (e2) => {
      const me2 = e2;
      const target = me2.target;
      const card = target.closest(".alert-card");
      if (!card) return;
      const relatedTarget = me2.relatedTarget;
      if (relatedTarget && card.contains(relatedTarget)) return;
      miniChartHoveredCard = null;
      destroyMiniChartOverlay();
    }, true);
    view.addEventListener("click", (e2) => {
      const btn = e2.target.closest(".show-more-btn");
      if (!btn) return;
      const tf = btn.dataset.timeframe;
      if (!tf) return;
      if (tf === "1d") {
        dailyVisibleCount += ALERTS_PAGE_SIZE;
        renderDivergenceContainer("1d");
      } else {
        weeklyVisibleCount += ALERTS_PAGE_SIZE;
        renderDivergenceContainer("1w");
      }
    });
  }
  function setDivergenceDailySort(mode) {
    if (mode === dailySortMode && mode !== "favorite") {
      dailySortDirection = dailySortDirection === "desc" ? "asc" : "desc";
    } else {
      dailySortMode = mode;
      dailySortDirection = "desc";
    }
    dailyVisibleCount = ALERTS_PAGE_SIZE;
    updateSortButtonUi("#view-divergence .divergence-daily-sort", dailySortMode, dailySortDirection);
    renderDivergenceContainer("1d");
  }
  function setDivergenceWeeklySort(mode) {
    if (mode === weeklySortMode && mode !== "favorite") {
      weeklySortDirection = weeklySortDirection === "desc" ? "asc" : "desc";
    } else {
      weeklySortMode = mode;
      weeklySortDirection = "desc";
    }
    weeklyVisibleCount = ALERTS_PAGE_SIZE;
    updateSortButtonUi("#view-divergence .divergence-weekly-sort", weeklySortMode, weeklySortDirection);
    renderDivergenceContainer("1w");
  }
  function initializeDivergenceSortDefaults() {
    dailySortMode = "score";
    dailySortDirection = "desc";
    weeklySortMode = "score";
    weeklySortDirection = "desc";
    dailyFeedMode = "1";
    weeklyFeedMode = "1";
    updateSortButtonUi("#view-divergence .divergence-daily-sort", dailySortMode, dailySortDirection);
    updateSortButtonUi("#view-divergence .divergence-weekly-sort", weeklySortMode, weeklySortDirection);
  }
  function setColumnFeedMode(column, mode, fetchData = true) {
    if (column === "daily") {
      dailyFeedMode = mode;
    } else {
      weeklyFeedMode = mode;
    }
    document.querySelectorAll(`.column-tf-controls[data-column="${column}"]`).forEach((controls) => {
      controls.querySelectorAll(".tf-btn[data-tf]").forEach((btn) => {
        const el = btn;
        el.classList.toggle("active", el.dataset.tf === mode);
      });
    });
    if (fetchData) {
      const timeframe = column === "daily" ? "1d" : "1w";
      fetchDivergenceSignalsByTimeframe(timeframe).then(() => renderDivergenceContainer(timeframe));
    }
  }

  // src/ticker.ts
  var tickerDailySortMode = "score";
  var tickerWeeklySortMode = "score";
  var tickerDailySortDirection = "desc";
  var tickerWeeklySortDirection = "desc";
  function setTickerDailySort(mode) {
    if (mode === tickerDailySortMode && mode !== "favorite") {
      tickerDailySortDirection = tickerDailySortDirection === "desc" ? "asc" : "desc";
    } else {
      tickerDailySortMode = mode;
      tickerDailySortDirection = "desc";
    }
    updateSortButtonUi(".ticker-daily-sort", tickerDailySortMode, tickerDailySortDirection);
    const tickerContainer = document.getElementById("ticker-view");
    if (!tickerContainer) return;
    const currentTicker = tickerContainer.dataset.ticker;
    if (currentTicker) renderTickerView(currentTicker, { refreshCharts: false });
  }
  function setTickerWeeklySort(mode) {
    if (mode === tickerWeeklySortMode && mode !== "favorite") {
      tickerWeeklySortDirection = tickerWeeklySortDirection === "desc" ? "asc" : "desc";
    } else {
      tickerWeeklySortMode = mode;
      tickerWeeklySortDirection = "desc";
    }
    updateSortButtonUi(".ticker-weekly-sort", tickerWeeklySortMode, tickerWeeklySortDirection);
    const tickerContainer = document.getElementById("ticker-view");
    if (!tickerContainer) return;
    const currentTicker = tickerContainer.dataset.ticker;
    if (currentTicker) renderTickerView(currentTicker, { refreshCharts: false });
  }
  function renderTickerView(ticker, options = {}) {
    const refreshCharts = options.refreshCharts !== false;
    const allAlerts2 = [...getAlerts(), ...getDivergenceSignals()];
    primeDivergenceSummaryCacheFromAlerts(allAlerts2);
    const alerts = allAlerts2.filter((a2) => a2.ticker === ticker);
    let daily = alerts.filter((a2) => (a2.timeframe || "").trim() === "1d");
    let weekly = alerts.filter((a2) => (a2.timeframe || "").trim() === "1w");
    const applyTickerDateFilter = (alerts2, mode) => {
      if (mode === "1") return filterToLatestNDates(alerts2, 1);
      if (mode === "2") return filterToLatestNDates(alerts2, 2);
      if (mode === "5") return filterToLatestNDates(alerts2, 5);
      return alerts2;
    };
    daily = applyTickerDateFilter(daily, getColumnFeedMode("daily"));
    weekly = applyTickerDateFilter(weekly, getColumnFeedMode("weekly"));
    if (tickerDailySortMode === "favorite") {
      daily = daily.filter((a2) => a2.is_favorite);
    }
    if (tickerWeeklySortMode === "favorite") {
      weekly = weekly.filter((a2) => a2.is_favorite);
    }
    daily.sort(createAlertSortFn(tickerDailySortMode === "favorite" ? "time" : tickerDailySortMode, tickerDailySortDirection));
    weekly.sort(createAlertSortFn(tickerWeeklySortMode === "favorite" ? "time" : tickerWeeklySortMode, tickerWeeklySortDirection));
    const dailyContainer = document.getElementById("ticker-daily-container");
    if (dailyContainer) {
      dailyContainer.innerHTML = daily.map(createAlertCard).join("");
      if (daily.length > 0) renderAlertCardDivergenceTablesFromCache(dailyContainer);
    }
    const weeklyContainer = document.getElementById("ticker-weekly-container");
    if (weeklyContainer) {
      weeklyContainer.innerHTML = weekly.map(createAlertCard).join("");
      if (weekly.length > 0) renderAlertCardDivergenceTablesFromCache(weeklyContainer);
    }
    if (refreshCharts) {
      renderCustomChart(ticker);
    }
  }

  // src/breadth.ts
  var breadthChart = null;
  var currentTimeframeDays = 5;
  var currentMetric = "SVIX";
  async function fetchBreadthData(ticker, days) {
    const response = await fetch(`/api/breadth?ticker=${ticker}&days=${days}`);
    if (!response.ok) {
      throw new Error("Failed to fetch breadth data");
    }
    return response.json();
  }
  function normalize(values) {
    if (values.length === 0) return [];
    const base = values[0];
    if (base === 0) return values.map(() => 100);
    return values.map((v2) => v2 / base * 100);
  }
  function renderBreadthChart(data, compLabel, intraday) {
    const canvas = document.getElementById("breadth-chart");
    if (!canvas) return;
    const appTimeZone = getAppTimeZone();
    if (breadthChart) {
      breadthChart.destroy();
      breadthChart = null;
    }
    const intradayDayCount = intraday ? new Set(
      data.map(
        (d2) => new Date(d2.date).toLocaleDateString("en-US", {
          timeZone: appTimeZone
        })
      )
    ).size : 0;
    const labels = data.map((d2) => {
      if (intraday) {
        const date2 = new Date(d2.date);
        if (intradayDayCount > 1) {
          return date2.toLocaleDateString("en-US", {
            month: "numeric",
            day: "numeric",
            timeZone: appTimeZone
          });
        }
        return date2.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: appTimeZone
        });
      }
      const date = /* @__PURE__ */ new Date(d2.date + "T00:00:00");
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: appTimeZone
      });
    });
    const spyRaw = data.map((d2) => d2.spy);
    const compRaw = data.map((d2) => d2.comparison);
    const spyNorm = normalize(spyRaw);
    const compNorm = normalize(compRaw);
    breadthChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "SPY",
            data: spyNorm,
            borderColor: "#58a6ff",
            backgroundColor: "transparent",
            borderWidth: 2.5,
            pointRadius: spyNorm.length > 15 ? 0 : 3,
            pointHoverRadius: 5,
            tension: 0.3,
            order: 1,
            fill: false
          },
          {
            label: compLabel,
            data: compNorm,
            borderColor: "#d2a8ff",
            backgroundColor: "transparent",
            borderWidth: 2.5,
            pointRadius: compNorm.length > 15 ? 0 : 3,
            pointHoverRadius: 5,
            tension: 0.3,
            order: 2,
            // Fill to the SPY dataset (index 0)
            fill: {
              target: 0,
              above: "rgba(63, 185, 80, 0.18)",
              // comparison above SPY → SPY < comparison → green
              below: "rgba(248, 81, 73, 0.18)"
              // comparison below SPY → SPY > comparison → red
            }
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false
        },
        plugins: {
          legend: {
            labels: {
              color: "#c9d1d9",
              font: { size: 12 },
              usePointStyle: true,
              pointStyle: "line"
            }
          },
          tooltip: {
            backgroundColor: "rgba(22, 27, 34, 0.95)",
            borderColor: "#30363d",
            borderWidth: 1,
            titleColor: "#c9d1d9",
            bodyColor: "#8b949e",
            padding: 12,
            callbacks: {
              label: function(context) {
                const val = context.parsed.y.toFixed(2);
                return `${context.dataset.label}: ${val}`;
              }
            }
          },
          filler: {
            propagate: true
          }
        },
        scales: {
          x: {
            ticks: {
              color: "#8b949e",
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 10,
              font: { size: 11 }
            },
            grid: {
              color: "rgba(48, 54, 61, 0.3)"
            }
          },
          y: {
            ticks: {
              color: "#8b949e",
              font: { size: 11 },
              callback: function(value) {
                return value.toFixed(1);
              }
            },
            grid: {
              color: "rgba(48, 54, 61, 0.3)"
            }
          }
        }
      }
    });
  }
  async function loadBreadth() {
    const error = document.getElementById("breadth-error");
    if (error) error.style.display = "none";
    try {
      const response = await fetchBreadthData(currentMetric, currentTimeframeDays);
      if (response.points.length === 0) {
        if (error) {
          error.textContent = "No data available for this timeframe";
          error.style.display = "block";
        }
        return;
      }
      renderBreadthChart(response.points, currentMetric, response.intraday);
    } catch (err) {
      console.error("Breadth load error:", err);
      if (error) {
        error.textContent = "Failed to load breadth data";
        error.style.display = "block";
      }
    }
  }
  function setBreadthTimeframe(days) {
    currentTimeframeDays = days;
    document.querySelectorAll("#breadth-tf-btns .tf-btn").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.days) === days);
    });
    loadBreadth();
  }
  function setBreadthMetric(metric) {
    currentMetric = metric;
    document.querySelectorAll("#breadth-metric-btns .tf-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.metric === metric);
    });
    loadBreadth();
  }
  function initBreadth() {
    loadBreadth();
  }

  // src/logs.ts
  var logsPollTimer = null;
  var logsRefreshInFlight = false;
  function escapeHtml2(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtNumber(value, digits = 0) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "--";
    return num.toFixed(Math.max(0, digits));
  }
  function fmtStatus(value) {
    const raw = String(value || "").trim();
    if (!raw) return "idle";
    return raw;
  }
  function fmtIsoToLocal(value) {
    const raw = String(value || "").trim();
    if (!raw) return "--";
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return "--";
    return parsed.toLocaleString();
  }
  function buildRunCardHtml(title, run, statusFallback) {
    const statusText = fmtStatus(run?.status || statusFallback?.status || (statusFallback?.running ? "running" : "idle"));
    const processed = Number(run?.tickers?.processed ?? statusFallback?.processed_tickers ?? 0);
    const total = Number(run?.tickers?.total ?? statusFallback?.total_tickers ?? 0);
    const errors = Number(run?.tickers?.errors ?? 0);
    const p95 = fmtNumber(run?.api?.p95LatencyMs, 1);
    const avg = fmtNumber(run?.api?.avgLatencyMs, 1);
    const calls = fmtNumber(run?.api?.calls, 0);
    const failures = fmtNumber(run?.api?.failures, 0);
    const rateLimited = fmtNumber(run?.api?.rateLimited, 0);
    const flushes = fmtNumber(run?.db?.flushCount, 0);
    const summaryRows = fmtNumber(run?.db?.summaryRows, 0);
    const signalRows = fmtNumber(run?.db?.signalRows, 0);
    const duration = fmtNumber(run?.durationSeconds, 1);
    const phase = escapeHtml2(run?.phase || "--");
    const failedList = Array.isArray(run?.failedTickers) ? run.failedTickers : [];
    const recoveredList = Array.isArray(run?.retryRecovered) ? run.retryRecovered : [];
    const failedCount = failedList.length;
    const recoveredCount = recoveredList.length;
    let failedSection = "";
    if (failedCount > 0 || recoveredCount > 0) {
      const failedItems = failedList.map((t) => `<span class="log-failed-ticker">${escapeHtml2(t)}</span>`).join("");
      const recoveredItems = recoveredList.map((t) => `<span class="log-recovered-ticker">${escapeHtml2(t)}</span>`).join("");
      failedSection = `
          <details class="log-failed-details">
            <summary class="log-failed-summary">
              ${failedCount > 0 ? `${failedCount} failed` : ""}${failedCount > 0 && recoveredCount > 0 ? ", " : ""}${recoveredCount > 0 ? `${recoveredCount} recovered via retry` : ""}
            </summary>
            <div class="log-failed-body">
              ${failedCount > 0 ? `<div class="log-failed-label">Failed:</div><div class="log-failed-list">${failedItems}</div>` : ""}
              ${recoveredCount > 0 ? `<div class="log-recovered-label">Recovered:</div><div class="log-failed-list">${recoveredItems}</div>` : ""}
            </div>
          </details>
        `;
    }
    return `
      <article class="log-run-card">
        <div class="log-run-card-title">
          <span>${escapeHtml2(title)}</span>
          <span class="log-run-card-status">${escapeHtml2(statusText)}</span>
        </div>
        <div class="log-run-metrics">
          <span class="log-metric-key">Tickers</span><span class="log-metric-val">${processed}/${total || 0}</span>
          <span class="log-metric-key">Errors</span><span class="log-metric-val">${errors}</span>
          <span class="log-metric-key">API calls</span><span class="log-metric-val">${calls}</span>
          <span class="log-metric-key">API fail</span><span class="log-metric-val">${failures}</span>
          <span class="log-metric-key">429 count</span><span class="log-metric-val">${rateLimited}</span>
          <span class="log-metric-key">API p95 ms</span><span class="log-metric-val">${p95}</span>
          <span class="log-metric-key">API avg ms</span><span class="log-metric-val">${avg}</span>
          <span class="log-metric-key">DB flushes</span><span class="log-metric-val">${flushes}</span>
          <span class="log-metric-key">Summary rows</span><span class="log-metric-val">${summaryRows}</span>
          <span class="log-metric-key">Signal rows</span><span class="log-metric-val">${signalRows}</span>
          <span class="log-metric-key">Duration s</span><span class="log-metric-val">${duration}</span>
          <span class="log-metric-key">Phase</span><span class="log-metric-val">${phase}</span>
        </div>
        ${failedSection}
      </article>
    `;
  }
  function buildConfigCardHtml(payload) {
    const config = payload.config || {};
    const source = escapeHtml2(config.divergenceSourceInterval || "--");
    const lookback = fmtNumber(config.divergenceLookbackDays, 0);
    const concurrency = fmtNumber(config.divergenceConcurrencyConfigured, 0);
    const flushSize = fmtNumber(config.divergenceFlushSize, 0);
    const rps = fmtNumber(config.dataApiMaxRequestsPerSecond, 0);
    const bucket = fmtNumber(config.dataApiRateBucketCapacity, 0);
    const timeout = fmtNumber(config.dataApiTimeoutMs, 0);
    const scheduler = payload.schedulerEnabled ? "on" : "off";
    return `
      <article class="log-run-card">
        <div class="log-run-card-title">
          <span>Runtime Config</span>
          <span class="log-run-card-status">${escapeHtml2(scheduler)}</span>
        </div>
        <div class="log-run-metrics">
          <span class="log-metric-key">Source</span><span class="log-metric-val">${source}</span>
          <span class="log-metric-key">Lookback d</span><span class="log-metric-val">${lookback}</span>
          <span class="log-metric-key">Concurrency</span><span class="log-metric-val">${concurrency}</span>
          <span class="log-metric-key">Flush size</span><span class="log-metric-val">${flushSize}</span>
          <span class="log-metric-key">API max rps</span><span class="log-metric-val">${rps}</span>
          <span class="log-metric-key">Bucket cap</span><span class="log-metric-val">${bucket}</span>
          <span class="log-metric-key">Timeout ms</span><span class="log-metric-val">${timeout}</span>
        </div>
      </article>
    `;
  }
  function renderRunCards(payload) {
    const host = document.getElementById("logs-run-cards");
    if (!host) return;
    const cards = [
      buildRunCardHtml("Fetch Daily", payload.runs?.fetchDaily, payload.statuses?.fetchDaily),
      buildRunCardHtml("Fetch Weekly", payload.runs?.fetchWeekly, payload.statuses?.fetchWeekly),
      buildRunCardHtml("VDF Scan", payload.runs?.vdfScan, payload.statuses?.vdfScan),
      buildConfigCardHtml(payload)
    ];
    host.innerHTML = cards.join("");
  }
  function renderHistory(payload) {
    const host = document.getElementById("logs-history-container");
    if (!host) return;
    const history = Array.isArray(payload.history) ? payload.history : [];
    if (history.length === 0) {
      host.innerHTML = '<div class="loading">No run history yet</div>';
      return;
    }
    host.innerHTML = history.slice(0, 15).map((run) => {
      const processed = Number(run?.tickers?.processed || 0);
      const total = Number(run?.tickers?.total || 0);
      const errors = Number(run?.tickers?.errors || 0);
      const calls = Number(run?.api?.calls || 0);
      const p95 = fmtNumber(run?.api?.p95LatencyMs, 1);
      const failedList = Array.isArray(run?.failedTickers) ? run.failedTickers : [];
      const recoveredList = Array.isArray(run?.retryRecovered) ? run.retryRecovered : [];
      const failedCount = failedList.length;
      const recoveredCount = recoveredList.length;
      let failedSection = "";
      if (failedCount > 0 || recoveredCount > 0) {
        const failedItems = failedList.map((t) => `<span class="log-failed-ticker">${escapeHtml2(t)}</span>`).join("");
        const recoveredItems = recoveredList.map((t) => `<span class="log-recovered-ticker">${escapeHtml2(t)}</span>`).join("");
        failedSection = `
              <details class="log-failed-details">
                <summary class="log-failed-summary">
                  ${failedCount > 0 ? `${failedCount} failed` : ""}${failedCount > 0 && recoveredCount > 0 ? ", " : ""}${recoveredCount > 0 ? `${recoveredCount} recovered` : ""}
                </summary>
                <div class="log-failed-body">
                  ${failedCount > 0 ? `<div class="log-failed-label">Failed:</div><div class="log-failed-list">${failedItems}</div>` : ""}
                  ${recoveredCount > 0 ? `<div class="log-recovered-label">Recovered:</div><div class="log-failed-list">${recoveredItems}</div>` : ""}
                </div>
              </details>
            `;
      }
      return `
          <article class="log-history-entry">
            <div class="log-history-header">
              <span>${escapeHtml2(String(run?.runType || "run"))}</span>
              <span>${escapeHtml2(fmtStatus(run?.status))}</span>
            </div>
            <div class="log-history-sub">
              ${escapeHtml2(fmtIsoToLocal(run?.startedAt))} |
              tickers ${processed}/${total}${errors > 0 ? ` (${errors} err)` : ""} |
              api ${calls} |
              p95 ${p95}ms
            </div>
            ${failedSection}
          </article>
        `;
    }).join("");
  }
  async function fetchRunMetricsPayload() {
    const response = await fetch("/api/logs/run-metrics", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to fetch run metrics (HTTP ${response.status})`);
    }
    return response.json();
  }
  async function refreshLogsView() {
    if (logsRefreshInFlight) return;
    logsRefreshInFlight = true;
    try {
      const payload = await fetchRunMetricsPayload();
      renderRunCards(payload);
      renderHistory(payload);
    } catch (error) {
      const host = document.getElementById("logs-history-container");
      if (host) host.innerHTML = '<div class="loading">Failed to load logs</div>';
      console.error("Failed to refresh logs view:", error);
    } finally {
      logsRefreshInFlight = false;
    }
  }
  function startLogsPolling() {
    if (logsPollTimer !== null) return;
    logsPollTimer = window.setInterval(() => {
      refreshLogsView().catch(() => {
      });
    }, 5e3);
  }
  function stopLogsPolling() {
    if (logsPollTimer === null) return;
    window.clearInterval(logsPollTimer);
    logsPollTimer = null;
  }
  function initLogsView() {
    const refreshBtn = document.getElementById("logs-refresh-btn");
    refreshBtn?.addEventListener("click", () => {
      refreshLogsView().catch(() => {
      });
    });
  }

  // src/main.ts
  var currentView = "divergence";
  var divergenceDashboardScrollY = 0;
  var tickerOriginView = "divergence";
  var tickerListContext = null;
  var appInitialized = false;
  var SITE_LOCK_LENGTH = 8;
  window.setTickerDailySort = setTickerDailySort;
  window.setTickerWeeklySort = setTickerWeeklySort;
  function getTickerListContext() {
    return tickerListContext;
  }
  function getTickerOriginView() {
    return tickerOriginView;
  }
  window.showTickerView = function(ticker, sourceView = "divergence", listContext = null) {
    tickerOriginView = sourceView;
    tickerListContext = listContext;
    divergenceDashboardScrollY = window.scrollY;
    if (currentView !== "divergence") {
      switchView("divergence");
    }
    setActiveNavTab("divergence");
    const tickerView = document.getElementById("ticker-view");
    if (tickerView) {
      cancelChartLoading();
      tickerView.dataset.ticker = ticker;
      document.getElementById("dashboard-view")?.classList.add("hidden");
      document.getElementById("view-divergence")?.classList.add("hidden");
      tickerView.classList.remove("hidden");
      renderTickerView(ticker);
      window.scrollTo(0, 0);
    }
  };
  window.showOverview = function() {
    cancelChartLoading();
    const tickerView = document.getElementById("ticker-view");
    if (tickerView) delete tickerView.dataset.ticker;
    switchView("divergence");
    window.scrollTo(0, divergenceDashboardScrollY);
  };
  function switchView(view) {
    currentView = view;
    setActiveNavTab(view);
    document.getElementById("view-logs")?.classList.add("hidden");
    document.getElementById("view-divergence")?.classList.add("hidden");
    document.getElementById("view-breadth")?.classList.add("hidden");
    document.getElementById("ticker-view")?.classList.add("hidden");
    cancelChartLoading();
    stopLogsPolling();
    closeAllHeaderDropdowns();
    if (view === "logs") {
      document.getElementById("view-logs")?.classList.remove("hidden");
      refreshLogsView().catch(() => {
      });
      startLogsPolling();
    } else if (view === "divergence") {
      document.getElementById("view-divergence")?.classList.remove("hidden");
      fetchDivergenceSignals(true).then(renderDivergenceOverview);
      syncDivergenceScanUiState();
    } else if (view === "breadth") {
      document.getElementById("view-breadth")?.classList.remove("hidden");
      initBreadth();
    }
  }
  function closeAllHeaderDropdowns() {
    document.getElementById("header-nav-dropdown")?.classList.add("hidden");
    document.getElementById("header-nav-dropdown")?.classList.remove("open");
  }
  function setActiveNavTab(view) {
    document.querySelectorAll(".header-nav-item").forEach((b2) => b2.classList.remove("active"));
    document.querySelector(`.header-nav-item[data-view="${view}"]`)?.classList.add("active");
  }
  function initSearch() {
    const toggleBtn = document.getElementById("search-toggle");
    const input = document.getElementById("search-input");
    const container = document.getElementById("search-container");
    if (!toggleBtn || !input || !container) return;
    toggleBtn.addEventListener("click", (e2) => {
      e2.stopPropagation();
      const isActive = input.classList.contains("active");
      if (isActive) {
        input.classList.remove("active");
        input.blur();
      } else {
        input.classList.add("active");
        input.focus();
      }
    });
    container.addEventListener("click", () => {
      if (!input.classList.contains("active")) {
        input.classList.add("active");
        input.focus();
      }
    });
    input.addEventListener("keydown", (e2) => {
      if (e2.key === "Enter") {
        const ticker = input.value.trim().toUpperCase();
        if (ticker) {
          window.showTickerView(ticker);
          input.value = "";
          input.blur();
          input.classList.remove("active");
        }
      }
    });
    document.addEventListener("keydown", (e2) => {
      if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement || document.activeElement.isContentEditable) {
        return;
      }
      if (e2.ctrlKey || e2.altKey || e2.metaKey || e2.key.length > 1) return;
      if (/^[a-zA-Z0-9]$/.test(e2.key)) {
        if (!input.classList.contains("active")) {
          input.classList.add("active");
        }
        input.focus();
      }
    });
  }
  async function refreshViewAfterTimeZoneChange() {
    if (currentView === "divergence") {
      await fetchDivergenceSignals(true);
      renderDivergenceOverview();
      return;
    }
    if (currentView === "breadth") {
      initBreadth();
      return;
    }
    if (currentView === "logs") {
      await refreshLogsView();
    }
  }
  function initGlobalSettingsPanel() {
    const container = document.getElementById("global-settings-container");
    const toggleBtn = document.getElementById("global-settings-toggle");
    const panel = document.getElementById("global-settings-panel");
    let timezoneSelect = document.getElementById("global-timezone-select");
    if (!container || !toggleBtn || !panel) return;
    const removeLegacyV3Row = () => {
      panel.querySelectorAll(".global-settings-toggle-row").forEach((node) => node.remove());
      const legacyById = panel.querySelector("#global-enable-v3-fetch, #enable-v3-fetch");
      if (legacyById) {
        (legacyById.closest(".global-settings-row") || legacyById).remove();
      }
      const allTextNodes = panel.querySelectorAll("label, span, div");
      allTextNodes.forEach((node) => {
        const text = String(node.textContent || "").trim().toLowerCase();
        if (text !== "enable v3 fetch") return;
        (node.closest(".global-settings-row") || node).remove();
      });
    };
    const ensureTimezoneSelect = () => {
      if (timezoneSelect) return timezoneSelect;
      const row = document.createElement("div");
      row.className = "global-settings-row global-settings-timezone-row";
      const label = document.createElement("label");
      label.className = "global-settings-label";
      label.htmlFor = "global-timezone-select";
      label.textContent = "Timezone";
      const select = document.createElement("select");
      select.id = "global-timezone-select";
      select.className = "glass-input global-settings-select";
      select.setAttribute("aria-label", "Timezone");
      row.append(label, select);
      panel.append(row);
      timezoneSelect = select;
      return select;
    };
    removeLegacyV3Row();
    timezoneSelect = ensureTimezoneSelect();
    const timezoneSelectEl = timezoneSelect;
    const closePanel = () => {
      panel.classList.add("hidden");
      toggleBtn.classList.remove("active");
    };
    const openPanel = () => {
      panel.classList.remove("hidden");
      toggleBtn.classList.add("active");
      timezoneSelectEl.value = getAppTimeZone();
    };
    const options = getAppTimeZoneOptions();
    timezoneSelectEl.innerHTML = options.map((option) => `<option value="${option.value}">${option.label}</option>`).join("");
    timezoneSelectEl.value = getAppTimeZone();
    timezoneSelectEl.addEventListener("change", () => {
      setAppTimeZone(timezoneSelectEl.value);
    });
    onAppTimeZoneChange((nextTimeZone) => {
      timezoneSelectEl.value = nextTimeZone;
      refreshViewAfterTimeZoneChange().catch((error) => {
        console.error("Failed to refresh UI after timezone change:", error);
      });
    });
    toggleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (panel.classList.contains("hidden")) {
        openPanel();
        syncDivergenceScanUiState().catch(() => {
        });
      } else {
        closePanel();
      }
    });
    panel.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!target) return;
      if (target.closest("#global-settings-container")) return;
      closePanel();
    });
  }
  async function checkServerSession() {
    try {
      const res = await fetch("/api/auth/check");
      return res.ok;
    } catch {
      return false;
    }
  }
  async function verifyPasscodeOnServer(passcode) {
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode })
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  async function initializeSiteLock(onUnlock) {
    const overlay = document.getElementById("site-lock-overlay");
    if (!overlay) {
      onUnlock();
      return;
    }
    if (!overlay.dataset.doubleTapBound) {
      overlay.addEventListener("dblclick", (event) => {
        event.preventDefault();
      });
      overlay.dataset.doubleTapBound = "1";
    }
    const panel = overlay.querySelector(".site-lock-panel");
    const statusEl = document.getElementById("site-lock-status");
    const dotEls = Array.from(overlay.querySelectorAll(".site-lock-dot"));
    const digitButtons = Array.from(overlay.querySelectorAll("[data-lock-digit]"));
    const actionButtons = Array.from(overlay.querySelectorAll("[data-lock-action]"));
    if (await checkServerSession()) {
      overlay.classList.add("hidden");
      document.body.classList.remove("site-locked");
      onUnlock();
      return;
    }
    document.body.classList.add("site-locked");
    overlay.classList.remove("hidden");
    let entered = "";
    let verifying = false;
    const updateDots = () => {
      for (let i = 0; i < dotEls.length; i++) {
        dotEls[i].classList.toggle("filled", i < entered.length);
      }
    };
    const setStatus = (message) => {
      if (!statusEl) return;
      statusEl.textContent = message;
    };
    const clearEntry = () => {
      entered = "";
      updateDots();
    };
    const handleSuccess = () => {
      overlay.classList.add("hidden");
      document.body.classList.remove("site-locked");
      window.removeEventListener("keydown", onKeyDown, true);
      onUnlock();
    };
    const handleFailure = () => {
      setStatus("");
      clearEntry();
      if (panel) {
        panel.classList.remove("shake");
        panel.offsetWidth;
        panel.classList.add("shake");
      }
      window.setTimeout(() => {
        if (panel) panel.classList.remove("shake");
      }, 320);
    };
    const verifyIfComplete = async () => {
      if (entered.length < SITE_LOCK_LENGTH || verifying) return;
      verifying = true;
      const passcode = entered;
      const ok = await verifyPasscodeOnServer(passcode);
      verifying = false;
      if (ok) {
        handleSuccess();
      } else {
        handleFailure();
      }
    };
    const appendDigit = (digit) => {
      if (!/^[0-9]$/.test(digit)) return;
      if (entered.length >= SITE_LOCK_LENGTH) return;
      entered += digit;
      setStatus("");
      updateDots();
      void verifyIfComplete();
    };
    const backspace = () => {
      if (!entered.length) return;
      entered = entered.slice(0, -1);
      setStatus("");
      updateDots();
    };
    digitButtons.forEach((button) => {
      button.addEventListener("click", () => {
        appendDigit(String(button.dataset.lockDigit || ""));
      });
    });
    actionButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const action = String(button.dataset.lockAction || "");
        if (action === "clear") {
          clearEntry();
          setStatus("");
          return;
        }
        if (action === "back") {
          backspace();
        }
      });
    });
    const onKeyDown = (event) => {
      if (overlay.classList.contains("hidden")) return;
      const key = event.key;
      if (/^[0-9]$/.test(key)) {
        event.preventDefault();
        appendDigit(key);
        return;
      }
      if (key === "Backspace") {
        event.preventDefault();
        backspace();
        return;
      }
      if (key === "Escape") {
        event.preventDefault();
        clearEntry();
        setStatus("");
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    updateDots();
  }
  function initHeaderNavDropdown() {
    const toggle = document.getElementById("header-nav-toggle");
    const dropdown = document.getElementById("header-nav-dropdown");
    if (!toggle || !dropdown) return;
    toggle.addEventListener("click", (e2) => {
      e2.stopPropagation();
      closeAllColumnCustomPanels();
      const isVisible = dropdown.classList.contains("open");
      if (isVisible) {
        dropdown.classList.remove("open");
        setTimeout(() => dropdown.classList.add("hidden"), 150);
      } else {
        dropdown.classList.remove("hidden");
        requestAnimationFrame(() => dropdown.classList.add("open"));
      }
    });
    dropdown.addEventListener("click", (e2) => {
      const item = e2.target.closest(".header-nav-item");
      if (!item) return;
      const view = item.dataset.view;
      if (view) {
        switchView(view);
        dropdown.classList.remove("open");
        setTimeout(() => dropdown.classList.add("hidden"), 150);
      }
    });
  }
  function initColumnTimeframeButtons() {
    document.addEventListener("click", (e2) => {
      const target = e2.target;
      const tfBtn = target.closest(".column-tf-controls .tf-btn[data-tf]");
      if (tfBtn) {
        const controls = tfBtn.closest(".column-tf-controls");
        if (!controls) return;
        const column = controls.dataset.column;
        const mode = tfBtn.dataset.tf;
        if (!column || !mode) return;
        if (mode === "custom") {
          const panel = controls.querySelector(".column-tf-custom-panel");
          if (panel) {
            const isVisible = !panel.classList.contains("hidden");
            closeAllColumnCustomPanels();
            if (!isVisible) {
              panel.classList.remove("hidden");
              requestAnimationFrame(() => panel.classList.add("open"));
            }
          }
          setColumnFeedMode(column, mode, false);
          return;
        }
        closeAllColumnCustomPanels();
        setColumnFeedMode(column, mode);
        return;
      }
      const applyBtn = target.closest(".column-tf-apply");
      if (applyBtn) {
        const panel = applyBtn.closest(".column-tf-custom-panel");
        if (panel) applyCustomDatePanel(panel);
        return;
      }
      if (target.closest(".column-tf-custom-panel")) return;
      if (!target.closest(".column-tf-controls")) {
        closeAllColumnCustomPanels();
      }
    });
    document.addEventListener("input", handleDateAutoFormat);
    document.addEventListener("keydown", handleDateKeydown);
  }
  function parseMmDdYyyy(value) {
    const m2 = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m2) return null;
    return `${m2[3]}-${m2[1]}-${m2[2]}`;
  }
  function handleDateAutoFormat(e2) {
    const input = e2.target;
    if (!input || !(input.classList.contains("column-tf-from") || input.classList.contains("column-tf-to"))) return;
    const raw = input.value;
    let digits = raw.replace(/\D/g, "");
    if (digits.length > 8) digits = digits.slice(0, 8);
    let formatted = "";
    if (digits.length <= 2) {
      formatted = digits;
    } else if (digits.length <= 4) {
      formatted = digits.slice(0, 2) + "/" + digits.slice(2);
    } else {
      formatted = digits.slice(0, 2) + "/" + digits.slice(2, 4) + "/" + digits.slice(4);
    }
    input.value = formatted;
    if (formatted.length === 10 && input.classList.contains("column-tf-from")) {
      const panel = input.closest(".column-tf-custom-panel");
      const toInput = panel?.querySelector(".column-tf-to");
      if (toInput && !toInput.value) {
        toInput.focus();
      }
    }
  }
  function handleDateKeydown(e2) {
    const input = e2.target;
    if (!input || !(input.classList.contains("column-tf-from") || input.classList.contains("column-tf-to"))) return;
    if (e2.key === "Enter") {
      e2.preventDefault();
      const panel = input.closest(".column-tf-custom-panel");
      const applyBtn = panel?.querySelector(".column-tf-apply");
      applyBtn?.click();
    }
  }
  function applyCustomDatePanel(panel) {
    const controls = panel.closest(".column-tf-controls");
    if (!controls) return;
    const column = controls.dataset.column;
    const fromInput = panel.querySelector(".column-tf-from");
    const toInput = panel.querySelector(".column-tf-to");
    const fromVal = parseMmDdYyyy(fromInput?.value || "");
    const toVal = parseMmDdYyyy(toInput?.value || "");
    if (column && fromVal && toVal) {
      setColumnCustomDates(column, fromVal, toVal);
      setColumnFeedMode(column, "custom");
    }
    closeAllColumnCustomPanels();
  }
  function closeAllColumnCustomPanels() {
    document.querySelectorAll(".column-tf-custom-panel").forEach((panel) => {
      panel.classList.remove("open");
      panel.classList.add("hidden");
    });
  }
  function bootstrapApplication() {
    if (appInitialized) return;
    appInitialized = true;
    document.getElementById("ticker-back-btn")?.addEventListener("click", window.showOverview);
    document.getElementById("divergence-fetch-daily-btn")?.addEventListener("click", () => {
      runManualDivergenceFetchDailyData();
    });
    document.getElementById("divergence-fetch-daily-stop-btn")?.addEventListener("click", () => {
      stopManualDivergenceFetchDailyData();
    });
    document.getElementById("divergence-fetch-weekly-btn")?.addEventListener("click", () => {
      runManualDivergenceFetchWeeklyData();
    });
    document.getElementById("divergence-fetch-weekly-stop-btn")?.addEventListener("click", () => {
      stopManualDivergenceFetchWeeklyData();
    });
    document.getElementById("divergence-vdf-scan-btn")?.addEventListener("click", () => {
      runManualVDFScan();
    });
    document.getElementById("divergence-vdf-scan-stop-btn")?.addEventListener("click", () => {
      stopManualVDFScan();
    });
    document.querySelectorAll(".ticker-daily-sort .tf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.sort;
        setTickerDailySort(mode);
      });
    });
    document.querySelectorAll(".ticker-weekly-sort .tf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.sort;
        setTickerWeeklySort(mode);
      });
    });
    document.querySelectorAll("#breadth-tf-btns .tf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const days = Number(btn.dataset.days);
        setBreadthTimeframe(days);
      });
    });
    document.querySelectorAll("#breadth-metric-btns .tf-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const metric = btn.dataset.metric;
        setBreadthMetric(metric);
        const subtitle = document.getElementById("breadth-subtitle");
        if (subtitle) subtitle.textContent = `SPY vs ${metric} \u2014 Normalized`;
      });
    });
    initHeaderNavDropdown();
    initColumnTimeframeButtons();
    document.addEventListener("click", (e2) => {
      const target = e2.target;
      if (!target) return;
      if (target.closest("#header-nav-container")) return;
      closeAllHeaderDropdowns();
    });
    initializeDivergenceSortDefaults();
    syncDivergenceScanUiState().catch(() => {
    });
    switchView("divergence");
    initGlobalSettingsPanel();
    initSearch();
    initLogsView();
    setupDivergenceFeedDelegation();
    setupMobileCollapse();
    initChartControls();
  }
  document.addEventListener("DOMContentLoaded", () => {
    initializeSiteLock(() => {
      bootstrapApplication();
    });
  });
  function setupMobileCollapse() {
    const attachCollapseHandler = (root, allowedContainerSelector) => {
      if (!root) return;
      root.addEventListener("click", (e2) => {
        if (window.innerWidth > 768) return;
        const target = e2.target;
        if (!target) return;
        const heading = target.closest("h2");
        if (!heading) return;
        const isInHeader = heading.closest(".column-header") || heading.closest(".header-title-group");
        if (!isInHeader) return;
        const column = heading.closest(".column");
        if (!column) return;
        if (!column.closest(allowedContainerSelector)) return;
        column.classList.toggle("collapsed");
      });
    };
    attachCollapseHandler(document.getElementById("view-divergence"), "#divergence-dashboard-view");
  }
})();
/*! Bundled license information:

lightweight-charts/dist/lightweight-charts.production.mjs:
  (*!
   * @license
   * TradingView Lightweight Charts™ v4.2.1
   * Copyright (c) 2024 TradingView, Inc.
   * Licensed under Apache License 2.0 https://www.apache.org/licenses/LICENSE-2.0
   *)
*/
//# sourceMappingURL=bundle.js.map
