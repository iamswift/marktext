export interface IFsRetryOptions {
  attempts?: number
  baseDelayMs?: number
  retryCodes?: readonly string[]
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Retries transient Windows sharing violations (antivirus scanners, the search
 * indexer, or an external tool briefly holding the file). Delays double per
 * attempt: 50/100/200/400ms for the default 5 attempts.
 */
export async function withFsRetry<T>(fn: () => Promise<T>, options?: IFsRetryOptions): Promise<T> {
  const attempts = options?.attempts ?? 5
  const baseDelayMs = options?.baseDelayMs ?? 50
  const retryCodes = options?.retryCodes ?? ['EBUSY', 'EPERM', 'EMFILE', 'EAGAIN']
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException)?.code
      if (attempt === attempts - 1 || !code || !retryCodes.includes(code)) {
        throw error
      }
      await sleep(baseDelayMs * 2 ** attempt)
    }
  }
  throw lastError
}
