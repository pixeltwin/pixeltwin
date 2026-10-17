// WebdriverIO service: `services: [[PixeltwinService, options]]`.
// WebdriverIO creates a service class given in `services` twice: in the launcher (onPrepare,
// onComplete: one build per run) and in every worker (before: the commands).
import {
  type Build,
  type Check,
  type CheckInput,
  CheckTimer,
  type CheckTiming,
  cssBoxToPixels,
  failsOnChange,
  PixeltwinCheckError,
  type PixeltwinClient,
  PixeltwinGateError,
  pngSize,
  postWithRetakes,
  type Rect,
  TimingTotals,
  timingLine,
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
import { findMarker, MARKER, MARKER_HEIGHT } from './marker.js';

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
   * Parts never compared: elements (`$()`, `$$()` results), CSS selectors (every match, found when
   * the screenshot is taken) or rectangles in screenshot pixels. Elements and selectors need a page:
   * a desktop or a mobile browser, not a native app.
   */
  ignore?: (ElementLike | Rect | string)[];
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

/** What `onResult` gets for every check: the check, its review link, how long it took, and its images on demand. */
export interface CheckResultInfo {
  name: string;
  check: Check;
  url: string;
  timing: CheckTiming;
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

/** Runs in the browser: the boxes of every element matching the selectors. */
function selectorBoxes(selectors: string[]): Rect[] {
  const boxes: Rect[] = [];
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const r = el.getBoundingClientRect();
      boxes.push({ x: r.x, y: r.y, width: r.width, height: r.height });
    }
  }
  return boxes;
}

/** Runs in the browser: a thin bar of `color` across the top of the page, over everything. */
function placeMarker(color: string, height: number): { width: number; height: number } {
  const bar = document.createElement('div');
  bar.id = '__pixeltwin_marker';
  bar.setAttribute(
    'style',
    `position:fixed;top:0;left:0;width:100%;height:${height}px;background:${color};z-index:2147483647;pointer-events:none`,
  );
  document.documentElement.appendChild(bar);
  return { width: window.innerWidth, height: window.innerHeight };
}

/** Runs in the browser: removes the marker bar. */
function removeMarker(): void {
  document.getElementById('__pixeltwin_marker')?.remove();
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
  readonly #timings = new TimingTotals();
  /** Where the page starts in a phone's screenshot, per viewport size (CSS pixels). */
  readonly #offsets = new Map<string, { x: number; y: number }>();

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

  /** Worker: sends how long this worker's checks took to the build (its summary adds them up). */
  async after(): Promise<void> {
    const buildId = process.env.PIXELTWIN_BUILD_ID;
    if (!this.#client || !buildId) return;
    try {
      await this.#timings.flush(this.#client, buildId);
    } catch (err) {
      console.warn(`pixeltwin: could not send the timings: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    const timer = new CheckTimer();
    const check = await postWithRetakes(
      async () => {
        const input = await timer.shoot(() => this.#shoot(target, element, name, options));
        // A retake is the same screen: keep the first screenshot's variant even if the window moved.
        variant ??= input.variant;
        return timer.post(() => client.postCheck(buildId, { ...input, variant }));
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
    const timing = timer.result();
    this.#timings.add(timing);
    console.info(timingLine(name, check, timing));
    await this.#options.onResult?.({ name, check, url, timing, images: () => imagesOf(client, check) });
    if ((options.failOnChange ?? settings.failOnChange) && failsOnChange(check)) {
      throw new PixeltwinCheckError(check, url);
    }
    return check;
  }

  /**
   * Screenshot pixels from the top left of a phone's screenshot to the page: a magenta bar shown at
   * the top of the page for one screenshot tells. Kept per viewport size (bars that collapse change it).
   */
  async #pageOffset(
    target: BrowserLike,
    name: string,
    viewport: { width: number; height: number },
  ): Promise<{ x: number; y: number }> {
    const key = `${viewport.width}x${viewport.height}`;
    const known = this.#offsets.get(key);
    if (known) return known;
    await target.execute(placeMarker, `rgb(${MARKER.join(',')})`, MARKER_HEIGHT);
    let found: { x: number; y: number } | null;
    try {
      found = findMarker(decode(await target.takeScreenshot()));
    } finally {
      await target.execute(removeMarker);
    }
    if (!found) {
      throw new Error(
        `pixeltwin: "${name}": could not find where the page starts in the screenshot; pass rectangles in ` +
          'screenshot pixels instead.',
      );
    }
    this.#offsets.set(key, found);
    return found;
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
    // A native app has no page; a mobile browser has one, measured like a desktop browser's.
    const nativeApp = mobile && !capabilities.browserName;
    const ignore = options.ignore ?? [];
    const selectors = ignore.filter((r): r is string => typeof r === 'string');
    const elementLikes = ignore.filter((r): r is ElementLike => typeof r !== 'string' && isElementLike(r));
    if (nativeApp && (elementLikes.length > 0 || selectors.length > 0)) {
      throw new Error(
        `pixeltwin: "${name}": a native app has no page to measure elements in; pass rectangles in screenshot ` +
          "pixels, or the service's `ignore` option.",
      );
    }
    const rects = ignore.filter((r): r is Rect => typeof r !== 'string' && !isElementLike(r));
    const elements = await elementsOf(elementLikes);
    const measured = nativeApp ? null : await target.execute(measure, element, ...elements);
    const found = selectors.length > 0 ? await target.execute(selectorBoxes, selectors) : [];
    // A phone's screenshot also shows the system bars: find where the page starts in it (once per size).
    const offset = mobile && measured && !element ? await this.#pageOffset(target, name, measured) : { x: 0, y: 0 };
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
      const mapping = { origin: element ? origin : { x: -offset.x / scale, y: -offset.y / scale }, scale };
      for (const box of [...measured.boxes, ...found]) {
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
