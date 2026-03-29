import { FailureClass } from "./enums";

export interface AppErrorOptions {
  code: string;
  message: string;
  failureClass?: FailureClass;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly failureClass: FailureClass;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.failureClass = options.failureClass ?? (options.retryable ? "transient" : "validation");
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
