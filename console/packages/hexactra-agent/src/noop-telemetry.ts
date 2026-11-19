// A telemetry port that records nothing: for a host without tracing. The harness behaves the same either way.
import type { TelemetryPort } from './ports';

export const noopTelemetry: TelemetryPort = {
  within: (fn) => fn(),
  toolCall: (_name, fn) => fn(),
  setTier: () => undefined,
  chunkStart: () => undefined,
  modelCall: () => undefined,
  modelFailed: () => undefined,
  useFallback: () => undefined,
  stepRecorded: () => undefined,
  toolAttributes: () => undefined,
  gated: () => undefined,
  asked: () => undefined,
  answered: () => undefined,
};
