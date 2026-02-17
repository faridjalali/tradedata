import { Alert } from './types';

let allAlerts: Alert[] = [];

export function getAlerts(): Alert[] {
  return allAlerts;
}

export function setAlerts(alerts: Alert[]): void {
  allAlerts = alerts;
}
