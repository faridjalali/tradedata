// State management

let allAlerts = [];

export function getAlerts() {
    return allAlerts;
}

export function setAlerts(alerts) {
    allAlerts = alerts;
}
