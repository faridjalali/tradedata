import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ConsoleSpanExporter, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

// Determine if we should export to console (dev) or OTLP (prod/configured)
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const exporter = otlpEndpoint ? new OTLPTraceExporter({ url: otlpEndpoint }) : new ConsoleSpanExporter(); // Fallback for local debugging

const spanProcessor = new BatchSpanProcessor(exporter);

const sdk = new NodeSDK({
  serviceName: 'tradingview-alerts-server',
  spanProcessor,
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable noisy instrumentation if desired
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .then(() => console.log('Tracing terminated'))
    .catch((error) => console.log('Error terminating tracing', error))
    .finally(() => process.exit(0));
});
