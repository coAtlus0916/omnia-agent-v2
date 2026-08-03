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

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL.ERROR', message: error instanceof Error ? error.message : '发生未知错误。' };
}
