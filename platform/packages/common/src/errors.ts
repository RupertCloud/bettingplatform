// Domain error carrying a stable code, rendered as RFC 9457 problem details (SRS IF-API-002).
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = 'AppError';
  }
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  [key: string]: unknown;
}

/** Never leaks stack traces or internal messages for unexpected errors (SRS SEC-API-007). */
export const toProblem = (err: unknown): Problem => {
  if (err instanceof AppError) {
    return {
      type: `urn:bp:error:${err.code}`,
      title: err.code,
      status: err.status,
      detail: err.detail,
      ...err.extra,
    };
  }
  return {
    type: 'urn:bp:error:internal',
    title: 'internal',
    status: 500,
    detail: 'An unexpected error occurred.',
  };
};
