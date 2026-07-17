import { describe, expect, it, vi } from 'vitest'
import { withFsRetry } from 'common/filesystem/retry'

const makeErr = (code: string): NodeJS.ErrnoException => {
  const err: NodeJS.ErrnoException = new Error(`fs failure: ${code}`)
  err.code = code
  return err
}

describe('withFsRetry', () => {
  it('returns the result on first success', async() => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withFsRetry(fn, { sleep: async() => {} })
    expect(result).toBe('ok')
  })

  it('retries EBUSY and eventually succeeds', async() => {
    let count = 0
    const fn = vi.fn().mockImplementation(() => {
      if (count++ < 2) return Promise.reject(makeErr('EBUSY'))
      return Promise.resolve('done')
    })
    const result = await withFsRetry(fn, { sleep: async() => {} })
    expect(result).toBe('done')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('rethrows a non-retryable code immediately', async() => {
    const fn = vi.fn().mockRejectedValue(makeErr('ENOENT'))
    await expect(withFsRetry(fn, { sleep: async() => {} })).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after the configured attempts', async() => {
    const fn = vi.fn().mockRejectedValue(makeErr('EPERM'))
    await expect(withFsRetry(fn, { attempts: 3, sleep: async() => {} })).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('passes exponential delays to sleep', async() => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    let count = 0
    const fn = vi.fn().mockImplementation(() => {
      if (count++ < 3) return Promise.reject(makeErr('EBUSY'))
      return Promise.resolve('done')
    })
    await expect(withFsRetry(fn, { baseDelayMs: 50, sleep })).resolves.toBe('done')
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([50, 100, 200])
  })
})
