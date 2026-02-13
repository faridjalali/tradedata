import { Alert } from './types';

let allDivergenceSignals: Alert[] = [];

export function getDivergenceSignals(): Alert[] {
    return allDivergenceSignals;
}

export function setDivergenceSignals(signals: Alert[]): void {
    allDivergenceSignals = signals;
}

/** Replace only signals matching `timeframe`, keeping the other timeframe untouched. */
export function setDivergenceSignalsByTimeframe(timeframe: '1d' | '1w', signals: Alert[]): void {
    const kept = allDivergenceSignals.filter((a) => (a.timeframe || '').trim() !== timeframe);
    allDivergenceSignals = [...kept, ...signals];
}

