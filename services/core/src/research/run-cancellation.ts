/**
 * Which agent runs this process is executing right now, and how to interrupt
 * them.
 *
 * This is an accelerator, never the source of truth. The authoritative fact —
 * "this run may no longer produce results" — lives in `agent_runs.status` and
 * is enforced by a row-locked write in the arena repository. The registry only
 * makes the process that is holding the provider connection stop early, which
 * saves time and tokens but decides nothing.
 *
 * That division matters for deployment: a second instance, or a process that
 * restarted mid-run, has an empty registry and therefore cannot abort anything
 * — and the run is still safe, because the write guard consults the database.
 * A design that trusted the registry would be wrong exactly there.
 */
export class RunCancellationRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /**
   * Registers a run before its first unit of work starts and returns the
   * signal the executor must pass down to the provider.
   */
  begin(runId: string): AbortSignal {
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller.signal;
  }

  /** The signal for a run this process is executing, if it still is. */
  signal(runId: string): AbortSignal | undefined {
    return this.controllers.get(runId)?.signal;
  }

  /**
   * Aborts the run if this process owns it and has not already aborted it.
   * `false` means the work is not happening here — another instance, or it
   * already finished or was already stopped — and the caller must say so
   * rather than claim the executor stopped.
   */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort();
    return true;
  }

  /** Releases the controller once the run has settled, in either direction. */
  end(runId: string): void {
    this.controllers.delete(runId);
  }

  /** How many runs this process is currently executing (diagnostics/tests). */
  get activeCount(): number {
    return this.controllers.size;
  }
}
