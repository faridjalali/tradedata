import { Alert } from './types';
import { getRelativeTime, formatVolume, escapeHtml } from './utils';
import { DIVERGENCE_LOOKBACK_DAYS } from './divergenceTable';

export function createAlertCard(alert: Alert): string {
    const timeStr = getRelativeTime(alert.timestamp);
    const source = alert.source === 'TV' ? 'TV' : 'DataAPI';
    
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
        <svg class="fav-icon ${starClass}" data-id="${alert.id}" data-source="${source}" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <polyline class="check-mark" points="9 12 11 14 15 10" style="visibility: ${checkmarkVisibility}; opacity: ${checkmarkOpacity};"></polyline>
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
                    <span class="source-text">${source}</span>
                </div>
            </div>

            <span class="alert-time">${timeStr}</span>
        </div>
    `;
}
