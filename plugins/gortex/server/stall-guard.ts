export interface StallGuardOptions {
  now?: () => number;
  firstPauseMs?: number;
  longestPauseMs?: number;
  /** How far back the host-wide check and the tally look. */
  hostWindowMs?: number;
  /** Refusals in a row, with no answer between them, before one repository pauses. */
  repositoryThreshold?: number;
  /** Repositories refusing, with nothing answered, before the whole host pauses. */
  hostThreshold?: number;
}
type Pause = { until: number; waitMs: number };
type Outcome = { key: string; at: number; answered: boolean; seq: number };

/**
 * Stops the plugin adding requests to a Gortex that is stuck, without reacting to one that refuses now and then.
 * Some hosts refuse a request intermittently (answered, refused, answered) while working normally; a stuck host
 * refuses everything for hours. So a repository pauses only after it has refused several automatic requests in a
 * row with no answer between them, for a minute and then doubling waits up to 5 minutes; the whole host pauses only
 * when several repositories are refusing and nothing has answered recently. Any answer ends its repository's pause
 * and the host's; Try now ends them all.
 */
export class StallGuard {
  private streaks = new Map<string, number>();
  private repositories = new Map<string, Pause>();
  private host: Pause | null = null;
  private outcomes: Outcome[] = [];
  /** Try now starts the host-wide check afresh: outcomes recorded before it no longer count toward pausing the host. */
  private seq = 0;
  private since = 0;
  private now: () => number;
  private firstPauseMs: number;
  private longestPauseMs: number;
  private hostWindowMs: number;
  private repositoryThreshold: number;
  private hostThreshold: number;
  constructor(options: StallGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    this.firstPauseMs = options.firstPauseMs ?? 60_000;
    this.longestPauseMs = options.longestPauseMs ?? 5 * 60_000;
    this.hostWindowMs = options.hostWindowMs ?? 2 * 60_000;
    this.repositoryThreshold = options.repositoryThreshold ?? 3;
    this.hostThreshold = options.hostThreshold ?? 3;
  }

  /** When automatic requests for this repository may resume, or null when they aren't paused. */
  pausedUntil(key: string): number | null {
    const until = Math.max(this.host?.until ?? 0, this.repositories.get(key)?.until ?? 0);
    return until > this.now() ? until : null;
  }

  /**
   * Records a refusal and returns how long this repository's automatic requests now pause: 0 while the refusals
   * still look occasional, so the next refresh simply asks again.
   */
  refused(key: string): number {
    const now = this.now();
    this.record(key, now, false);
    const streak = (this.streaks.get(key) ?? 0) + 1;
    this.streaks.set(key, streak);
    let waitMs = 0;
    if (streak >= this.repositoryThreshold) {
      const previous = this.repositories.get(key);
      waitMs = previous ? Math.min(previous.waitMs * 2, this.longestPauseMs) : this.firstPauseMs;
      this.repositories.set(key, { until: now + waitMs, waitMs });
    }
    // Stuck looks like this: several repositories refusing, and nothing answered at all within the window.
    const recent = this.outcomes.filter(outcome => now - outcome.at <= this.hostWindowMs && outcome.seq > this.since);
    const refusing = new Set(recent.filter(outcome => !outcome.answered).map(outcome => outcome.key));
    if (refusing.size >= this.hostThreshold && !recent.some(outcome => outcome.answered)) {
      const hostWaitMs = this.host ? Math.min(this.host.waitMs * 2, this.longestPauseMs) : this.firstPauseMs;
      this.host = { until: now + hostWaitMs, waitMs: hostWaitMs };
      waitMs = Math.max(waitMs, hostWaitMs);
    }
    return waitMs;
  }

  answered(key: string): void {
    this.record(key, this.now(), true);
    this.streaks.delete(key);
    this.repositories.delete(key);
    this.host = null;
  }

  resume(): void {
    this.since = this.seq;
    this.streaks.clear();
    this.repositories.clear();
    this.host = null;
  }

  /** How many requests Gortex answered and refused within the window: occasional refusals are shown, not acted on. */
  tally(): { answered: number; refused: number; windowMs: number } {
    const now = this.now();
    const recent = this.outcomes.filter(outcome => now - outcome.at <= this.hostWindowMs * 5);
    return { answered: recent.filter(outcome => outcome.answered).length, refused: recent.filter(outcome => !outcome.answered).length, windowMs: this.hostWindowMs * 5 };
  }

  private record(key: string, at: number, answered: boolean): void {
    this.outcomes.push({ key, at, answered, seq: ++this.seq });
    // Bounded: the tally window is minutes long and the plugin's own traffic is a few requests a minute.
    const horizon = at - this.hostWindowMs * 5;
    while (this.outcomes.length && (this.outcomes[0].at < horizon || this.outcomes.length > 500)) this.outcomes.shift();
  }
}
