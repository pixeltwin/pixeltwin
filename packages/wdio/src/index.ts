// WebdriverIO service: `services: [[PixeltwinService, options]]`.
// WebdriverIO creates a service class given in `services` twice: in the launcher (onPrepare,
// onComplete: one build per run) and in every worker (before: the commands).
import {
  type Build,
  type Check,
  type CheckInput,
  cssBoxToPixels,
  failsOnChange,
  PixeltwinCheckError,
  type PixeltwinClient,
  PixeltwinGateError,
  pngSize,
  postWithRetakes,
  type Rect,
  toPixelRect,
  type Variant,
} from '@pixeltwin/client';
import {
  clientFor,
  finishRun,
  type PixeltwinOptions,
  resolveSettings,
  runBuildId,
  startRun,
} from '@pixeltwin/client/run';

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
  /**
   * Parts never compared: elements (`$()`, `$$()` results; browsers only) or rectangles in
   * screenshot pixels.
   */
  ignore?: (ElementLike | Rect)[];
  /** Merged over the automatic variant and the service's `variant`. */
  variant?: Variant;
  colorThreshold?: number;
  tolerancePercent?: number;
  /** Override the service's `retakes` and `failOnChange` for this check. */
  retakes?: number;
  failOnChange?: boolean;
}

/** A session's capabilities, as WebdriverIO reports them. */
export type Capabilities = { browserName?: string; platformName?: string; [key: string]: unknown };

/** The images of a compared check, PNG bytes; `baseline` and `diff` are null when there is none. */
export interface CheckImages {
  baseline: Uint8Array | null;
  current: Uint8Array;
  diff: Uint8Array | null;
}

/** What `onResult` gets for every check: the check, its review link, and its images on demand. */
export interface CheckResultInfo {
  name: string;
  check: Check;
  url: string;
  images(): Promise<CheckImages>;
}

export interface PixeltwinServiceOptions extends PixeltwinOptions {
  /**
   * Variant keys for every check, merged over the automatic ones (`{ theme: 'dark' }`), or a
   * function that returns the variant from the automatic one and the capabilities (to rename keys).
   */
  variant?: Variant | ((auto: Variant, capabilities: Capabilities) => Variant);
  /**
   * Rectangles (screenshot pixels) never compared on any viewport screenshot, or a function of the
   * session and the screenshot size: an iOS status bar, a browser toolbar.
   */
  ignore?: Rect[] | ((session: { capabilities: Capabilities; width: number; height: number }) => Rect[]);
  /** Called after every check (and its retakes): attach its images to a report, log, … */
  onResult?: (result: CheckResultInfo) => void | Promise<void>;
}

/** The parts of a WebdriverIO browser the service uses. */
export interface BrowserLike {
  capabilities: Capabilities;
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

/** An Appium session on a phone (native app or mobile browser): no DOM measurement there. */
export function isMobileSession(capabilities: Capabilities): boolean {
  return /^(ios|android)$/i.test(String(capabilities.platformName ?? ''));
}

const capability = (capabilities: Capabilities, name: string): string | undefined => {
  const value = capabilities[`appium:${name}`] ?? capabilities[name];
  return value === undefined || value === null || value === '' ? undefined : String(value);
};

/**
 * The automatic variant. A browser: `browser` and `viewport` (CSS pixels). An Appium phone: `os`
 * (platform and version), `device` (the device name) and, in a mobile browser, `browser`.
 */
export function autoVariant(capabilities: Capabilities, viewport: { width: number; height: number } | null): Variant {
  if (isMobileSession(capabilities)) {
    const os = [capability(capabilities, 'platformName'), capability(capabilities, 'platformVersion')]
      .filter(Boolean)
      .join(' ');
    return {
      os,
      device: capability(capabilities, 'deviceName') ?? 'unknown',
      ...(capabilities.browserName ? { browser: String(capabilities.browserName) } : {}),
    };
  }
  return {
    browser: String(capabilities.browserName ?? 'unknown'),
    viewport: viewport ? `${viewport.width}x${viewport.height}` : 'unknown',
  };
}

async function imagesOf(client: PixeltwinClient, check: Check): Promise<CheckImages> {
  const [current, baseline, diff] = await Promise.all([
    client.fetchImage(check.links.image),
    check.links.baseline ? client.fetchImage(check.links.baseline) : null,
    check.links.diff ? client.fetchImage(check.links.diff) : null,
  ]);
  return { current, baseline, diff };
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

  /**
   * Screenshots the viewport (`element` null) or an element and posts the check, retaking it while
   * it comes back `changed` (`retakes`); then `onResult`, and with `failOnChange` a throw.
   */
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
    const buildId = runBuildId('pixeltwin: no build for this run. Add [PixeltwinService, options] to `services`.');
    this.#client ??= clientFor(settings);
    const client = this.#client;

    const retakes = options.retakes ?? settings.retakes;
    let variant: Variant | undefined;
    const check = await postWithRetakes(
      async () => {
        const input = await this.#shoot(target, element, name, options);
        // A retake is the same screen: keep the first screenshot's variant even if the window moved.
        variant ??= input.variant;
        return client.postCheck(buildId, { ...input, variant });
      },
      {
        retakes,
        intervalMs: settings.retakeIntervalMs,
        onRetake: (changed, retake) => {
          const percent = changed.diff && 'percent' in changed.diff ? ` (${changed.diff.percent}%)` : '';
          console.info(`pixeltwin: "${name}" changed${percent}, retake ${retake}/${retakes}`);
        },
      },
    );
    const url = client.checkUrl(check);
    await this.#options.onResult?.({ name, check, url, images: () => imagesOf(client, check) });
    if ((options.failOnChange ?? settings.failOnChange) && failsOnChange(check)) {
      throw new PixeltwinCheckError(check, url);
    }
    return check;
  }

  /** One screenshot with its ignore regions (screenshot pixels) and variant. */
  async #shoot(
    target: BrowserLike,
    element: { elementId: string } | null,
    name: string,
    options: WdioCheckOptions,
  ): Promise<CheckInput> {
    const capabilities = target.capabilities;
    const mobile = isMobileSession(capabilities);
    const ignore = options.ignore ?? [];
    const elementLikes = ignore.filter(isElementLike);
    if (mobile && elementLikes.length > 0) {
      throw new Error(
        `pixeltwin: "${name}": ignoring elements needs a desktop browser; on a phone pass rectangles in screenshot ` +
          "pixels, or the service's `ignore` option.",
      );
    }
    const rects = ignore.filter((r): r is Rect => !isElementLike(r));
    const elements = await elementsOf(elementLikes);
    // A phone screenshot also shows the system bars, so DOM boxes would not line up with it.
    const measured = mobile ? null : await target.execute(measure, element, ...elements);
    const image = decode(
      element ? await target.takeElementScreenshot(element.elementId) : await target.takeScreenshot(),
    );
    const size = pngSize(image);
    const ignoreRegions: Rect[] = rects.map((r) => toPixelRect(r, size)).filter((r) => r !== null);
    if (measured) {
      const origin = element ? measured.target : { x: 0, y: 0, width: measured.width, height: measured.height };
      if (!origin || origin.width <= 0)
        throw new Error(`pixeltwin: "${name}": the element to screenshot is not visible.`);
      // Screenshot pixels per CSS pixel: the device pixel ratio, read from the image itself.
      const scale = (size?.width ?? origin.width) / origin.width;
      const mapping = { origin: element ? origin : { x: 0, y: 0 }, scale };
      for (const box of measured.boxes) {
        const region = box ? cssBoxToPixels(box, mapping, size) : null;
        if (region) ignoreRegions.push(region);
      }
    }
    const runIgnore = this.#options.ignore;
    if (!element && runIgnore && size) {
      const fixed = typeof runIgnore === 'function' ? runIgnore({ capabilities, ...size }) : runIgnore;
      for (const r of fixed) {
        const region = toPixelRect(r, size);
        if (region) ignoreRegions.push(region);
      }
    }

    const auto = autoVariant(capabilities, measured ? { width: measured.width, height: measured.height } : null);
    const own = this.#options.variant;
    const base = typeof own === 'function' ? own(auto, capabilities) : { ...auto, ...own };
    return {
      name,
      image,
      variant: { ...base, ...options.variant },
      ignoreRegions,
      colorThreshold: options.colorThreshold,
      tolerancePercent: options.tolerancePercent,
    };
  }
}

export default PixeltwinService;
export type { Build, Check, Rect, Variant, Verdict } from '@pixeltwin/client';
export { PixeltwinCheckError, PixeltwinError, PixeltwinGateError, PixeltwinNetworkError } from '@pixeltwin/client';
export type { PixeltwinOptions } from '@pixeltwin/client/run';
