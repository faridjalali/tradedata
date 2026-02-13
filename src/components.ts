import { Alert } from './types';
import { formatVolume, escapeHtml } from './utils';
import { DIVERGENCE_LOOKBACK_DAYS } from './divergenceTable';

function formatAlertCardDate(rawDate: string | null | undefined): string {
    const value = String(rawDate || '').trim();
    if (!value) return '';

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
        return '';
    }

    return `${parsed.getMonth() + 1}/${parsed.getDate()}`;
}

export function createAlertCard(alert: Alert): string {
    const timeStr = formatAlertCardDate(alert.divergence_trade_date || alert.timestamp) || '--';
    const source = alert.source === 'TV' ? 'TV' : 'DataAPI';
    const maStates = alert.ma_states || {};
    
    let isBull = false;
    let isBear = false;

    if (alert.signal_direction !== undefined && alert.signal_direction !== null) {
        const dir = Number(alert.signal_direction);
        isBull = dir === 1;
        isBear = dir === -1;
    } else {
        isBull = !!(alert.signal_type && alert.signal_type.toLowerCase().includes('bull'));
        isBear = !isBull;
    }

    const cardClass = isBull ? 'bullish-card' : (isBear ? 'bearish-card' : '');
    
    const volStr = formatVolume(alert.signal_volume || 0);
    // Strict boolean check
    const isFav = alert.is_favorite === true || String(alert.is_favorite).toLowerCase() === 'true';
    const starClass = isFav ? 'filled' : '';
    
    // Explicit HTML for Checked vs Unchecked states
    const checkmarkVisibility = isFav ? 'visible' : 'hidden';
    const checkmarkOpacity = isFav ? '1' : '0';

    // Checkbox Icon
    const starIcon = `
        <svg class="fav-icon ${starClass}" data-id="${alert.id}" data-source="${source}" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2.25" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <polyline class="check-mark" points="7.5 12.5 10.5 15.5 16.5 9.5" style="visibility: ${checkmarkVisibility}; opacity: ${checkmarkOpacity};"></polyline>
        </svg>
    `;

    const divergenceMiniCells = DIVERGENCE_LOOKBACK_DAYS
        .map((days) => {
            const key = String(days);
            const state = String(alert.divergence_states?.[key] || 'neutral').toLowerCase();
            const cls = state === 'bullish'
                ? 'is-bullish'
                : (state === 'bearish' ? 'is-bearish' : 'is-neutral');
            return `<span class="divergence-mini-cell ${cls}" data-days="${days}">${days}</span>`;
        })
        .join('');

    const divergenceTitle = alert.divergence_trade_date
        ? `Daily divergence as of ${escapeHtml(alert.divergence_trade_date)}`
        : 'Daily divergence';
    const maDots = `
        <span class="ma-dot-row" title="8 EMA, 21 EMA, 50 SMA, 200 SMA">
            <span class="ma-dot ${maStates.ema8 ? 'is-up' : 'is-down'}"></span>
            <span class="ma-dot ${maStates.ema21 ? 'is-up' : 'is-down'}"></span>
            <span class="ma-dot ${maStates.sma50 ? 'is-up' : 'is-down'}"></span>
            <span class="ma-dot ${maStates.sma200 ? 'is-up' : 'is-down'}"></span>
        </span>
    `;

    return `
        <div class="alert-card ${cardClass}" data-ticker="${escapeHtml(alert.ticker)}" data-source="${source}">
            ${starIcon}
            <h3>${escapeHtml(alert.ticker)}</h3>
            
            <div class="metrics-container">
                <div class="metric-item" title="Daily divergence summary">
                    <div class="divergence-mini" data-ticker="${escapeHtml(alert.ticker)}" title="${divergenceTitle}">
                        ${divergenceMiniCells}
                    </div>
                </div>
                <div class="metric-item" title="Signal Volume">
                    <span class="volume-text">${volStr}</span>
                    ${maDots}
                </div>
            </div>

            <span class="alert-time">${timeStr}</span>
        </div>
    `;
}
