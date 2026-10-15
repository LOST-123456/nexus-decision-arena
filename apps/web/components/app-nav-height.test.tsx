import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppNavHeightObserver,
  NAV_HEIGHT_TOKEN,
  NAV_SELECTOR,
  publishNavHeight
} from "./app-nav-height";

/**
 * `--app-nav-h` drives every `calc(100dvh - var(--app-nav-h))` shell, so a wrong
 * number shows up as a scrollbar exactly one bar-height long. The bar wraps to
 * three rows on a phone and one on a desktop, so the token has to be measured,
 * not guessed. These tests pin the measurement contract down:
 *  - the token is written in px from the element's real box;
 *  - it is refreshed when the bar is resized;
 *  - the observer is torn down on unmount.
 */

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];

  readonly observed: Element[] = [];

  disconnected = false;

  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverStub.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(): void {
    /* not needed by the component under test */
  }

  disconnect(): void {
    this.disconnected = true;
  }

  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function rect(height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 390,
    bottom: height,
    width: 390,
    height,
    toJSON: () => ({})
  } as DOMRect;
}

/** Indexing the registry is `| undefined` under `noUncheckedIndexedAccess`. */
function observerAt(index: number): ResizeObserverStub {
  const instance = ResizeObserverStub.instances[index];
  if (!instance) {
    throw new Error(`no ResizeObserverStub was constructed at index ${index}`);
  }
  return instance;
}

let nav: HTMLDivElement;

beforeEach(() => {
  ResizeObserverStub.instances = [];
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

  document.documentElement.style.removeProperty(NAV_HEIGHT_TOKEN);
  nav = document.createElement("div");
  nav.setAttribute("data-testid", "app-nav");
  document.body.appendChild(nav);
});

afterEach(() => {
  cleanup();
  nav.remove();
  document.documentElement.style.removeProperty(NAV_HEIGHT_TOKEN);
});

describe("publishNavHeight", () => {
  it("writes the measured height onto the token in px", () => {
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(rect(60.2));

    const measured = publishNavHeight(nav, document.documentElement);

    expect(measured).toBe(60.2);
    expect(document.documentElement.style.getPropertyValue(NAV_HEIGHT_TOKEN)).toBe("60.2px");
  });
});

describe("AppNavHeightObserver", () => {
  it("publishes the bar height on mount and observes the bar", () => {
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(rect(170.9));

    render(<AppNavHeightObserver />);

    // The 5.2rem fallback must be gone once the real box is known.
    expect(document.documentElement.style.getPropertyValue(NAV_HEIGHT_TOKEN)).toBe("170.9px");

    const observer = observerAt(0);
    expect(observer.observed).toEqual([nav]);
    expect(document.querySelector(NAV_SELECTOR)).toBe(nav);
  });

  it("re-publishes when the bar wraps to a different height", () => {
    const box = vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(rect(60.2));
    render(<AppNavHeightObserver />);

    expect(document.documentElement.style.getPropertyValue(NAV_HEIGHT_TOKEN)).toBe("60.2px");

    box.mockReturnValue(rect(138.4));
    observerAt(0).fire();

    expect(document.documentElement.style.getPropertyValue(NAV_HEIGHT_TOKEN)).toBe("138.4px");
  });

  it("stops observing once unmounted", () => {
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(rect(60.2));

    const view = render(<AppNavHeightObserver />);
    const observer = observerAt(0);

    view.unmount();

    expect(observer.disconnected).toBe(true);
  });

  it("is a no-op when the bar is not in the document", () => {
    nav.remove();
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(rect(60.2));

    render(<AppNavHeightObserver />);

    expect(document.documentElement.style.getPropertyValue(NAV_HEIGHT_TOKEN)).toBe("");
    expect(ResizeObserverStub.instances).toHaveLength(0);
  });
});
