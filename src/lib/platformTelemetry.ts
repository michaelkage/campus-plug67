export type PlatformTelemetryStatus = 'success' | 'error' | 'cancelled' | 'timeout';

export interface PlatformTelemetryEvent {
  requestId: string;
  traceId?: string;
  service: string;
  operation: string;
  status: PlatformTelemetryStatus;
  durationMs?: number;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

export const createRequestId = () => newId('req');
export const createTraceId = () => newId('trace');

export const measureAsync = async <T>(
  event: Omit<PlatformTelemetryEvent, 'requestId' | 'status' | 'durationMs'> & { requestId?: string },
  operation: () => Promise<T>,
): Promise<T> => {
  const requestId = event.requestId ?? createRequestId();
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    const result = await operation();
    const durationMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
    if (import.meta.env.DEV) {
      console.debug('[CampusPlug telemetry]', { ...event, requestId, status: 'success', durationMs });
    }
    return result;
  } catch (error) {
    const durationMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
    if (import.meta.env.DEV) {
      console.error('[CampusPlug telemetry]', {
        ...event,
        requestId,
        status: 'error',
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
};
