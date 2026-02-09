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

    return `
        <div class="alert-card ${cardClass}" data-ticker="${alert.ticker}">
            <h3>${alert.ticker}</h3>
            
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
