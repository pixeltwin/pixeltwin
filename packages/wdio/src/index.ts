// WebdriverIO service: `services: [[PixeltwinService, options]]`.
// WebdriverIO creates a service class given in `services` twice: in the launcher (onPrepare,
// onComplete: one build per run) and in every worker (before: the commands).
import {
  type Build,
  type Check,
  cssBoxToPixels,
  type PixeltwinClient,
  PixeltwinGateError,
  pngSize,
  type Rect,
  toPixelRect,
  type Variant,
} from '@pixeltwin/client';
import { clientFor, finishRun, type PixeltwinOptions, resolveSettings, startRun } from '@pixeltwin/client/run';

/** A WebdriverIO element. */
export type WdioElement = { elementId: string };

/**
 * A WebdriverIO element or several: an element, the chainable promise `$()` returns, an element
 * array or the chainable promise `$$()` returns.
 */
export type ElementLike =
  | WdioElement
  | PromiseLike<WdioElement>
  | Iterable<WdioElement>
  | PromiseLike<Iterable<WdioElement>>;

export interface WdioCheckOptions {
  /** Parts never compared: elements (`$()`, `$$()` results) or rectangles in screenshot pixels. */
  ignore?: (ElementLike | Rect)[];
  /** Merged over the automatic variant (browser + viewport) and the service's `variant`. */
  variant?: Variant;
  colorThreshold?: number;
  tolerancePercent?: number;
}

export interface PixeltwinServiceOptions extends PixeltwinOptions {
  /** Extra variant keys for every check, e.g. `{ theme: 'dark' }`. */
  variant?: Variant;
}

/** The parts of a WebdriverIO browser the service uses. */
export interface BrowserLike {
  capabilities: { browserName?: string; [key: string]: unknown };
  takeScreenshot(): Promise<string>;
  takeElementScreenshot(elementId: string): Promise<string>;
  // biome-ignore lint/suspicious/noExplicitAny: WebdriverIO's execute takes any script arguments.
  execute<T>(script: (...args: any[]) => T, ...args: unknown[]): Promise<T>;
  /**
   * WebdriverIO 10 takes `{ attachToElement }` (a boolean throws); 8 and 9 take a boolean there and
   * only test it for truthiness, so the object form works for all three.
   */
  // biome-ignore lint/suspicious/noExplicitAny: WebdriverIO commands take any arguments.
  addCommand(name: string, fn: (this: any, ...args: any[]) => unknown, options?: { attachToElement?: boolean }): void;
}

interface Measured {
  width: number;
  height: number;
  target: Rect | null;
  boxes: (Rect | null)[];
}

declare global {
  namespace WebdriverIO {
    interface Browser {
      /** Screenshots the viewport and posts it to pixeltwin as check `name`. Null when disabled. */
      pixeltwinCheck(name: string, options?: WdioCheckOptions): Promise<Check | null>;
    }
    interface Element {
      /** Screenshots this element and posts it to pixeltwin as check `name`. Null when disabled. */
      pixeltwinCheck(name: string, options?: WdioCheckOptions): Promise<Check | null>;
    }
  }
}

/** An error WebdriverIO's launcher does not swallow: it stops the run with exit code 1. */
export class SevereServiceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SevereServiceError';
  }
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === 'object' && value !== null && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
  );
}

function isElementLike(value: unknown): value is ElementLike {
  return (
    isIterable(value) ||
    typeof (value as { elementId?: unknown })?.elementId === 'string' ||
    typeof (value as PromiseLike<unknown>)?.then === 'function'
  );
}

/** Every element the ignore list names: `$$()` results are spread, since `execute` only turns
 * top-level element arguments into references. */
async function elementsOf(ignore: ElementLike[]): Promise<WdioElement[]> {
  const elements: WdioElement[] = [];
  for (const item of ignore) {
    const resolved = await item;
    for (const element of isIterable(resolved) ? resolved : [resolved]) {
      if (typeof element?.elementId === 'string') elements.push(element);
    }
  }
  return elements;
}

function decode(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Runs in the browser: viewport size and the boxes of the target and the ignored elements. */
function measure(...elements: (Element | null)[]): Measured {
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const [target, ...ignored] = elements;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    target: rect(target ?? null),
    boxes: ignored.map(rect),
  };
}

export class PixeltwinService {
  readonly #options: PixeltwinServiceOptions;
  #build: Build | null = null;
  #sharded = false;
  #restoreEnv: (() => void) | null = null;
  #client: PixeltwinClient | null = null;
  #browser: BrowserLike | null = null;

  constructor(options: PixeltwinServiceOptions = {}) {
    this.#options = options;
  }

  /** Launcher: opens the run's build; workers inherit `PIXELTWIN_BUILD_ID`. */
  async onPrepare(config: { shard?: { current: number; total: number } } = {}): Promise<void> {
    this.#sharded = (config.shard?.total ?? 1) > 1;
    try {
      const run = await startRun(resolveSettings(this.#options), { sharded: this.#sharded });
      this.#build = run.build;
      this.#restoreEnv = run.restoreEnv;
    } catch (err) {
      throw new SevereServiceError(err instanceof Error ? err.message : String(err), err);
    }
  }

  /** Launcher: finalizes the build, prints the summary and applies the gate. */
  async onComplete(): Promise<void> {
    const build = this.#build;
    try {
      if (build) await finishRun(resolveSettings(this.#options), build.id, { sharded: this.#sharded });
    } catch (err) {
      const message = err instanceof PixeltwinGateError || err instanceof Error ? err.message : String(err);
      throw new SevereServiceError(message, err);
    } finally {
      this.#restoreEnv?.();
      this.#restoreEnv = null;
      this.#build = null;
    }
  }

  /** Worker: adds `browser.pixeltwinCheck` and `element.pixeltwinCheck`. */
  before(_capabilities: unknown, _specs: unknown, browser: BrowserLike): void {
    this.#browser = browser;
    const service = this;
    browser.addCommand('pixeltwinCheck', function (this: BrowserLike, name: string, options?: WdioCheckOptions) {
      return service.check(this ?? browser, null, name, options);
    });
    browser.addCommand(
      'pixeltwinCheck',
      function (this: { elementId: string }, name: string, options?: WdioCheckOptions) {
        return service.check(browser, this, name, options);
      },
      { attachToElement: true },
    );
  }

  /** Screenshots the viewport (`element` null) or an element and posts the check. */
  async check(
    browser: BrowserLike | null,
    element: { elementId: string } | null,
    name: string,
    options: WdioCheckOptions = {},
  ): Promise<Check | null> {
    const settings = resolveSettings(this.#options);
    if (settings.disabled) return null;
    const target = browser ?? this.#browser;
    if (!target) throw new Error('pixeltwin: the service has no browser yet (is it in `services`?).');
    const buildId = process.env.PIXELTWIN_BUILD_ID;
    if (!buildId) {
      throw new Error('pixeltwin: no build for this run. Add [PixeltwinService, options] to `services`.');
    }
    this.#client ??= clientFor(settings);

    const ignore = options.ignore ?? [];
    const elements = await elementsOf(ignore.filter(isElementLike));
    const rects = ignore.filter((r): r is Rect => !isElementLike(r));
    const measured = await target.execute(measure, element, ...elements);
    const image = decode(
      element ? await target.takeElementScreenshot(element.elementId) : await target.takeScreenshot(),
    );
    const size = pngSize(image);
    const origin = element ? measured.target : { x: 0, y: 0, width: measured.width, height: measured.height };
    if (!origin || origin.width <= 0)
      throw new Error(`pixeltwin: "${name}": the element to screenshot is not visible.`);
    // Screenshot pixels per CSS pixel: the device pixel ratio, read from the image itself.
    const scale = (size?.width ?? origin.width) / origin.width;
    const mapping = { origin: element ? origin : { x: 0, y: 0 }, scale };
    const ignoreRegions = [
      ...rects.map((r) => toPixelRect(r, size)),
      ...measured.boxes.map((b) => (b ? cssBoxToPixels(b, mapping, size) : null)),
    ].filter((r) => r !== null);

    const variant: Variant = {
      browser: String(target.capabilities.browserName ?? 'unknown'),
      viewport: `${measured.width}x${measured.height}`,
      ...this.#options.variant,
      ...options.variant,
    };
    return this.#client.postCheck(buildId, {
      name,
      image,
      variant,
      ignoreRegions,
      colorThreshold: options.colorThreshold,
      tolerancePercent: options.tolerancePercent,
    });
  }
}

export default PixeltwinService;
export type { Build, Check, Rect, Variant, Verdict } from '@pixeltwin/client';
export { PixeltwinError, PixeltwinGateError, PixeltwinNetworkError } from '@pixeltwin/client';
export type { PixeltwinOptions } from '@pixeltwin/client/run';
