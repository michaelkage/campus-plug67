import type { DomainError, DomainErrorCode } from './contracts'

export class CampusPlugError extends Error {
  readonly code: DomainErrorCode
  readonly retryable: boolean
  readonly correlationId?: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(error: DomainError) {
    super(error.message)
    this.name = 'CampusPlugError'
    this.code = error.code
    this.retryable = error.retryable
    this.correlationId = error.correlationId
    this.details = error.details
  }
}

export function toDomainError(error: unknown): DomainError {
  if (error instanceof CampusPlugError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId: error.correlationId,
      details: error.details,
    }
  }

  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const candidate = error as { code?: unknown; message?: unknown; details?: unknown }
    const message = typeof candidate.message === 'string' ? candidate.message : 'The operation failed.'
    const code = typeof candidate.code === 'string' ? candidate.code : 'UNKNOWN'
    const mapped: DomainErrorCode = code === 'PGRST116' ? 'NOT_FOUND'
      : code === '23505' ? 'CONFLICT'
      : code === '42501' ? 'FORBIDDEN'
      : 'UNKNOWN'
    return {
      code: mapped,
      message,
      retryable: false,
      details: candidate.details && typeof candidate.details === 'object'
        ? candidate.details as Record<string, unknown>
        : undefined,
    }
  }

  return {
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : 'An unexpected error occurred.',
    retryable: false,
  }
}
