/**
 * jsdom ships no `ResizeObserver`, but the app shell measures its own bar and
 * publishes the height as `--app-nav-h`. Install a no-op so component tests can
 * render the shell; tests that actually exercise the callbacks install their own
 * stub, which replaces this one.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {
    /* nothing to measure in jsdom */
  }

  unobserve(): void {
    /* nothing to measure in jsdom */
  }

  disconnect(): void {
    /* nothing to measure in jsdom */
  }
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver;
}
