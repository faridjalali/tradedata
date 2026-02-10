import { Alert } from './types';
import { getRelativeTime, formatVolume, escapeHtml } from './utils';

export function createAlertCard(alert: Alert): string {
    const timeStr = getRelativeTime(alert.timestamp);
    
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
    const intScore = alert.intensity_score || 0;
    const cmbScore = alert.combo_score || 0;

    const fillColor = isBull ? '#3fb950' : '#f85149';
    const emptyColor = '#0d1117'; 

    const intStyle = `background: conic-gradient(${fillColor} ${intScore}%, ${emptyColor} 0%);`;
    const cmbStyle = `background: conic-gradient(${fillColor} ${cmbScore}%, ${emptyColor} 0%);`;

    // Strict boolean check
    const isFav = alert.is_favorite === true || String(alert.is_favorite).toLowerCase() === 'true';
    const starClass = isFav ? 'filled' : '';
    
    // Explicit HTML for Checked vs Unchecked states
    const checkmarkVisibility = isFav ? 'visible' : 'hidden';
    const checkmarkOpacity = isFav ? '1' : '0';

    // Checkbox Icon
    const starIcon = `
        <svg class="fav-icon ${starClass}" data-id="${alert.id}" viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <polyline class="check-mark" points="9 12 11 14 15 10" style="visibility: ${checkmarkVisibility}; opacity: ${checkmarkOpacity};"></polyline>
        </svg>
    `;

    return `
        <div class="alert-card ${cardClass}" data-ticker="${escapeHtml(alert.ticker)}">
            ${starIcon}
            <h3>${escapeHtml(alert.ticker)}</h3>
            
            <div class="metrics-container">
                <div class="metric-item" title="Intensity: ${intScore}">
                    <div class="score-circle" style="${intStyle}"></div>
                </div>
                <div class="metric-item" title="Combo: ${cmbScore}">
                    <div class="score-circle" style="${cmbStyle}"></div>
                </div>
                <div class="metric-item" title="Signal Volume">
                    <span class="volume-text">${volStr}</span>
                </div>
            </div>

            <span class="alert-time">${timeStr}</span>
        </div>
    `;
}
