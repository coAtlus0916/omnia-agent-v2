export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function publicError(error: unknown): {
  code: string;
  message: string;
  interactionId?: string;
  traceId?: string;
  failurePoint?: string;
} {
  const candidate = error as Error & { code?: string; interactionId?: string; traceId?: string; failurePoint?: string };
  return {
    code: error instanceof AppError ? error.code : candidate?.code || 'INTERNAL.ERROR',
    message: error instanceof Error ? error.message : '发生未知错误。',
    ...(candidate?.interactionId ? { interactionId: candidate.interactionId } : {}),
    ...(candidate?.traceId ? { traceId: candidate.traceId } : {}),
    ...(candidate?.failurePoint ? { failurePoint: candidate.failurePoint } : {})
  };
}
