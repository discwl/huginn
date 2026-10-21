export interface StallGuardOptions { now?: () => number; firstPauseMs?: number; longestPauseMs?: number; hostWindowMs?: number }
type Pause = { until: number; waitMs: number };

/**
 * Remembers which repositories Gortex is refusing, so the plugin stops adding requests to a stuck host. After a
 * refusal, automatic requests for that repository pause for a minute, then 2, 4 and at most 10 minutes while the
 * refusals continue. Two repositories refused within a minute pause the whole host the same way, because one stuck
 * checkout lane refuses every repository. An answer from Gortex ends the repository's pause and the host's; Try now
 * ends them all.
 */
export class StallGuard {
  private repositories = new Map<string, Pause & { at: number }>();
  private host: Pause | null = null;
  private now: () => number;
  private firstPauseMs: number;
  private longestPauseMs: number;
  private hostWindowMs: number;
  constructor(options: StallGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.firstPauseMs = options.firstPauseMs ?? 60_000;
    this.longestPauseMs = options.longestPauseMs ?? 10 * 60_000;
    this.hostWindowMs = options.hostWindowMs ?? 60_000;
  }

  /** When automatic requests for this repository may resume, or null when they aren't paused. */
  pausedUntil(key: string): number | null {
    const until = Math.max(this.host?.until ?? 0, this.repositories.get(key)?.until ?? 0);
    return until > this.now() ? until : null;
  }

  /** Records a refusal and returns how long this repository's automatic requests now pause. */
  refused(key: string): number {
    const now = this.now();
    const previous = this.repositories.get(key);
    const waitMs = previous ? Math.min(previous.waitMs * 2, this.longestPauseMs) : this.firstPauseMs;
    this.repositories.set(key, { until: now + waitMs, waitMs, at: now });
    const others = [...this.repositories].some(([other, pause]) => other !== key && now - pause.at <= this.hostWindowMs);
    if (!others) return waitMs;
    const hostWaitMs = this.host ? Math.min(this.host.waitMs * 2, this.longestPauseMs) : this.firstPauseMs;
    this.host = { until: now + hostWaitMs, waitMs: hostWaitMs };
    return Math.max(waitMs, hostWaitMs);
  }

  answered(key: string): void {
    this.repositories.delete(key);
    this.host = null;
  }

  resume(): void {
    this.repositories.clear();
    this.host = null;
  }
}
