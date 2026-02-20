import client from 'prom-client';

// Collect default metrics (memory, CPU, event loop, etc.)
client.collectDefaultMetrics({
  labels: { app: 'tradingview-alerts-server' },
});

// Define custom metrics
export const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10], // Request duration buckets
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

export const activeConnectionsGauge = new client.Gauge({
  name: 'active_db_connections',
  help: 'Number of active database connections from the application pool',
  labelNames: ['pool_name'],
});

export const metricsRegistry = client.register;
