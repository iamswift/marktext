export interface IUnlinkCoalescerOptions {
  /**
   * How long to hold an unlink before trusting it. Must exceed the watcher's
   * awaitWriteFinish stability threshold so a delete-then-recreate save
   * pattern's follow-up change event can arrive first.
   */
  windowMs?: number
  fileExists: (pathname: string) => Promise<boolean>
  onConfirmedUnlink: (pathname: string) => void
}

/**
 * On Windows, external tools that save by deleting and recreating a file make
 * chokidar emit a spurious unlink followed by a change (verified empirically;
 * temp+rename saves arrive as a plain change and never hit this path). Holding
 * the unlink for a settle window — and re-checking existence when it expires —
 * turns that sequence into the single change event the renderer expects,
 * instead of a false "file removed on disk" warning.
 */
export class UnlinkCoalescer {
  private readonly _windowMs: number
  private readonly _fileExists: (pathname: string) => Promise<boolean>
  private readonly _onConfirmedUnlink: (pathname: string) => void
  private readonly _pending = new Map<string, NodeJS.Timeout>()
  private _disposed = false

  constructor(options: IUnlinkCoalescerOptions) {
    this._windowMs = options.windowMs ?? 1500
    this._fileExists = options.fileExists
    this._onConfirmedUnlink = options.onConfirmedUnlink
  }

  handleUnlink(pathname: string): void {
    this.handleReappear(pathname)
    const timer = setTimeout(() => {
      this._pending.delete(pathname)
      this._confirm(pathname).catch(console.error)
    }, this._windowMs)
    this._pending.set(pathname, timer)
  }

  /** Call on any add/change for the path — cancels the pending unlink. */
  handleReappear(pathname: string): void {
    const timer = this._pending.get(pathname)
    if (timer) {
      clearTimeout(timer)
      this._pending.delete(pathname)
    }
  }

  dispose(): void {
    this._disposed = true
    for (const timer of this._pending.values()) {
      clearTimeout(timer)
    }
    this._pending.clear()
  }

  private async _confirm(pathname: string): Promise<void> {
    let stillGone = true
    try {
      stillGone = !(await this._fileExists(pathname))
    } catch {
      // Treat an unreadable path as gone; the renderer copes with a stale
      // removal warning better than with a silently dropped one.
    }
    if (!this._disposed && stillGone) {
      this._onConfirmedUnlink(pathname)
    }
  }
}
