import { Alert } from './types';
import { getRelativeTime, formatVolume } from './utils';

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

    const intLabel = `Intensity: ${intScore}`;
    const cmbLabel = `Combo: ${cmbScore}`;

    const starClass = alert.is_favorite ? 'filled' : '';
    const starIcon = `
        <svg class="star-icon ${starClass}" data-id="${alert.id}" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
    `;

    return `
        <div class="alert-card ${cardClass}" data-ticker="${alert.ticker}">
            <div class="card-header">
                ${starIcon}
                <h3>${alert.ticker}</h3>
            </div>
            
            <div class="metrics-container">
                <div class="metric-item" title="${intLabel}">
                    <div class="score-circle" style="${intStyle}"></div>
                </div>
                <div class="metric-item" title="${cmbLabel}">
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
