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

/**
 * jsdom implements no scrolling at all: `Element.prototype.scrollIntoView` is
 * simply absent, so any component that keeps an active row in view throws the
 * moment a list renders. A browser has it, and the no-op is the honest stand-in
 * for "there is no viewport here to scroll".
 */
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* nothing to scroll in jsdom */
  };
}
