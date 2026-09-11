/** Serializes plugin-owned native tracking and metadata writes across all clients of this host. */
export class RepositoryAdminLock {
  private busy = false;
  private unverified: string | null = null;
  stopWrites(reason: string): void { this.unverified = reason; }
  acquire(): () => void {
    if (this.unverified) throw new Error(this.unverified);
    if (this.busy) throw new Error("Another repository administration change is in progress on this host. Wait for it to finish.");
    this.busy = true;
    let released = false;
    return () => { if (!released) { released = true; this.busy = false; } };
  }
}
