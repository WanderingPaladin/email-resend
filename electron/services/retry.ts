export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  isRetryable: (error: unknown) => boolean;
  /** Optional explicit delay, e.g. from a Retry-After header. */
  delayFor?: (error: unknown, attempt: number) => number | undefined;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Exponential backoff with jitter. Only use for operations that are safe to repeat. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const wait = options.sleepFn ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= options.retries || !options.isRetryable(error)) throw error;
      attempt++;
      const explicit = options.delayFor?.(error, attempt);
      const backoff = Math.min(options.maxDelayMs ?? 30_000, options.baseDelayMs * 2 ** (attempt - 1));
      const delay = explicit ?? backoff + Math.floor(Math.random() * options.baseDelayMs * 0.25);
      options.onRetry?.(error, attempt, delay);
      await wait(delay);
    }
  }
}
