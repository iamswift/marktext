import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UnlinkCoalescer } from 'main_renderer/filesystem/unlinkCoalescer'

const PATH = 'C:/docs/note.md'

describe('UnlinkCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('forwards an unlink once the window expires and the file is still gone', async() => {
    const onConfirmedUnlink = vi.fn()
    const coalescer = new UnlinkCoalescer({
      fileExists: async() => false,
      onConfirmedUnlink
    })
    coalescer.handleUnlink(PATH)
    expect(onConfirmedUnlink).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    expect(onConfirmedUnlink).toHaveBeenCalledExactlyOnceWith(PATH)
  })

  it('drops the unlink when a change arrives inside the window', async() => {
    const onConfirmedUnlink = vi.fn()
    const coalescer = new UnlinkCoalescer({
      fileExists: async() => true,
      onConfirmedUnlink
    })
    coalescer.handleUnlink(PATH)
    await vi.advanceTimersByTimeAsync(300)
    coalescer.handleReappear(PATH)
    await vi.advanceTimersByTimeAsync(5000)
    expect(onConfirmedUnlink).not.toHaveBeenCalled()
  })

  it('drops the unlink when the file exists again at expiry', async() => {
    const onConfirmedUnlink = vi.fn()
    const coalescer = new UnlinkCoalescer({
      fileExists: async() => true,
      onConfirmedUnlink
    })
    coalescer.handleUnlink(PATH)
    await vi.advanceTimersByTimeAsync(5000)
    expect(onConfirmedUnlink).not.toHaveBeenCalled()
  })

  it('restarts the window when the same path unlinks again', async() => {
    const onConfirmedUnlink = vi.fn()
    const coalescer = new UnlinkCoalescer({
      windowMs: 1000,
      fileExists: async() => false,
      onConfirmedUnlink
    })
    coalescer.handleUnlink(PATH)
    await vi.advanceTimersByTimeAsync(800)
    coalescer.handleUnlink(PATH)
    await vi.advanceTimersByTimeAsync(800)
    expect(onConfirmedUnlink).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(onConfirmedUnlink).toHaveBeenCalledTimes(1)
  })

  it('never fires after dispose', async() => {
    const onConfirmedUnlink = vi.fn()
    const coalescer = new UnlinkCoalescer({
      fileExists: async() => false,
      onConfirmedUnlink
    })
    coalescer.handleUnlink(PATH)
    coalescer.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onConfirmedUnlink).not.toHaveBeenCalled()
  })

  it('tracks multiple paths independently', async() => {
    const onConfirmedUnlink = vi.fn()
    const coalescer = new UnlinkCoalescer({
      fileExists: async() => false,
      onConfirmedUnlink
    })
    coalescer.handleUnlink('a.md')
    coalescer.handleUnlink('b.md')
    coalescer.handleReappear('a.md')
    await vi.advanceTimersByTimeAsync(1500)
    expect(onConfirmedUnlink).toHaveBeenCalledExactlyOnceWith('b.md')
  })
})
