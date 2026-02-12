import { Alert } from './types';

let allDivergenceSignals: Alert[] = [];

export function getDivergenceSignals(): Alert[] {
    return allDivergenceSignals;
}

export function setDivergenceSignals(signals: Alert[]): void {
    allDivergenceSignals = signals;
}

