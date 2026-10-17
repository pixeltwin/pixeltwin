import {
  type Check,
  type CheckInput,
  CheckTimer,
  type CheckTiming,
  type CollectOptions,
  type CssToPixels,
  collectElements,
  cssBoxToPixels,
  elementsToPixels,
  failsOnChange,
  MAX_ELEMENTS,
  PixeltwinCheckError,
  type PixeltwinClient,
  pngSize,
  postWithRetakes,
  type RawElement,
  type Rect,
  type TimingTotals,
  timingLine,
  toPixelRect,
  type Variant,
} from '@pixeltwin/client';
import { runBuildId, type Settings } from '@pixeltwin/client/run';
import type { Locator, Page, PageScreenshotOptions, TestInfo } from '@playwright/test';

/** Screenshot options passed through to Playwright. */
export type ScreenshotOptions = Pick<
  PageScreenshotOptions,
  'animations' | 'caret' | 'scale' | 'style' | 'timeout' | 'clip' | 'omitBackground' | 'maskColor'
>;

export interface CheckOptions {
  /**
   * Parts never compared: locators (every matching visible element) or rectangles in screenshot
   * pixels. Sent as `ignoreRegions`; the screenshot itself keeps them.
   */
  ignore?: (Locator | Rect)[];
  /** Playwright's `mask`: painted over in the screenshot itself. */
  mask?: Locator[];
  /** The whole scrollable page instead of the viewport (page targets only). */
  fullPage?: boolean;
  /** Merged over the automatic variant (browser + viewport) and `pixeltwinVariant`. */
  variant?: Variant;
  colorThreshold?: number;
  tolerancePercent?: number;
  /** A diff within the tolerance waits for review instead of passing (default: the project's setting). */
  reviewWithinTolerance?: boolean;
  /** Other Playwright screenshot options. `animations` defaults to `disabled`, `caret` to `hide`. */
  screenshot?: ScreenshotOptions;
  /** Override `retakes` and `failOnChange` (options or PIXELTWIN_* variables) for this check. */
  retakes?: number;
  failOnChange?: boolean;
  /**
   * Send the boxes of the visible elements (test ids, roles, text) with the screenshot, so the diff
   * names what changed. Default: on (`PIXELTWIN_ELEMENTS=0` or the `elements` option turns it off).
   */
  elements?: boolean;
}

/** The images of a compared check, PNG bytes; `baseline` and `diff` are null when there is none. */
export interface CheckImages {
  baseline: Uint8Array | null;
  current: Uint8Array;
  diff: Uint8Array | null;
}

/** What `pixeltwinOnResult` gets for every check: the check, its review link, its images on demand. */
export interface CheckResultInfo {
  name: string;
  check: Check;
  url: string;
  testInfo: TestInfo;
  /** How long the check took: screenshots, upload, the server's compare, retakes. */
  timing: CheckTiming;
  images(): Promise<CheckImages>;
}

/** How the fixture behaves: from the run's settings and the `pixeltwin*` options. */
export interface PixeltwinBehaviour {
  settings: Pick<Settings, 'retakes' | 'retakeIntervalMs' | 'failOnChange'> & { elements?: boolean };
  /** Attach expected, actual and diff to the test when a check is not unchanged. Default true. */
  attachImages: boolean;
  onResult?: ((result: CheckResultInfo) => void | Promise<void>) | undefined;
  /** The worker's timing totals, sent to the build when the worker ends. */
  timings?: TimingTotals | undefined;
}

async function imagesOf(client: PixeltwinClient, check: Check): Promise<CheckImages> {
  const [current, baseline, diff] = await Promise.all([
    client.fetchImage(check.links.image),
    check.links.baseline ? client.fetchImage(check.links.baseline) : null,
    check.links.diff ? client.fetchImage(check.links.diff) : null,
  ]);
  return { current, baseline, diff };
}

function isPage(target: Page | Locator): target is Page {
  return typeof (target as Page).goto === 'function';
}

function isLocator(value: unknown): value is Locator {
  return typeof (value as Locator)?.boundingBox === 'function';
}

interface PageMetrics {
  dpr: number;
  /** Page zoom: below 1 when a phone shows a page without a viewport meta tag zoomed out. */
  zoom: number;
  /** Visible width in CSS pixels. */
  visibleWidth: number;
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  /** The document's scrollable size in CSS pixels: what a full-page screenshot covers. */
  docWidth: number;
  docHeight: number;
}

function metricsOf(page: Page): Promise<PageMetrics> {
  return page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    zoom: window.visualViewport?.scale ?? 1,
    visibleWidth: window.visualViewport?.width ?? window.innerWidth,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
    docWidth: document.documentElement.scrollWidth,
    docHeight: document.documentElement.scrollHeight,
  }));
}

/**
 * Screenshot pixels per CSS pixel of a full-page screenshot, from the image and the document size.
 * When that agrees with the expected ratio (the device pixel ratio, or 1 for `scale: 'css'`) within
 * the image's own rounding, the exact expected ratio is used.
 */
function fullPageScale(
  size: { width: number; height: number } | null,
  width: number,
  height: number,
  assumed: number,
): { x: number; y: number } {
  if (!size || !(width > 0) || !(height > 0)) return { x: assumed, y: assumed };
  const agrees = Math.abs(size.width - width * assumed) <= 1 && Math.abs(size.height - height * assumed) <= 1;
  return agrees ? { x: assumed, y: assumed } : { x: size.width / width, y: size.height / height };
}

/** The page's elements in the captured area; none (with a warning) when the page does not let us measure. */
async function elementsOf(page: Page, clip: Rect | null, name: string): Promise<RawElement[]> {
  try {
    const options: CollectOptions = { clip, max: MAX_ELEMENTS };
    return await page.evaluate(collectElements, options);
  } catch (err) {
    console.warn(
      `pixeltwin: "${name}": could not measure the page's elements, sending the screenshot without them: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

async function boxesOf(locators: Locator[]): Promise<Rect[]> {
  const boxes: Rect[] = [];
  for (const locator of locators) {
    for (const element of await locator.all()) {
      const box = await element.boundingBox();
      if (box && box.width > 0 && box.height > 0) boxes.push(box);
    }
  }
  return boxes;
}

/** The `pixeltwin` fixture: one per test. */
export class Pixeltwin {
  readonly client: PixeltwinClient | null;
  readonly #testInfo: TestInfo;
  readonly #browserName: string;
  readonly #variant: Variant;
  readonly #behaviour: PixeltwinBehaviour;

  constructor(
    client: PixeltwinClient | null,
    testInfo: TestInfo,
    browserName: string,
    variant: Variant,
    behaviour: PixeltwinBehaviour = {
      settings: { retakes: 0, retakeIntervalMs: 1000, failOnChange: false },
      attachImages: true,
    },
  ) {
    this.client = client;
    this.#testInfo = testInfo;
    this.#browserName = browserName;
    this.#variant = variant;
    this.#behaviour = behaviour;
  }

  /** The run's build (set by `@pixeltwin/playwright/setup`); undefined when disabled. */
  get buildId(): string | undefined {
    return process.env.PIXELTWIN_BUILD_ID || undefined;
  }

  /**
   * Screenshots a page or an element and posts it as check `name`, retaking it while it comes back
   * `changed` (`retakes`). Resolves to the compared check; a `changed` or `new` result does not fail
   * the test (the build verdict decides at the end) unless `failOnChange` is on. Null when disabled.
   */
  async check(target: Page | Locator, name: string, options: CheckOptions = {}): Promise<Check | null> {
    const client = this.client;
    if (!client) return null;
    const buildId = runBuildId(
      "pixeltwin: no build for this run. Add globalSetup: '@pixeltwin/playwright/setup' " +
        "(or wrap the config in withPixeltwin from '@pixeltwin/playwright/config').",
    );
    const { settings } = this.#behaviour;
    const retakes = options.retakes ?? settings.retakes;
    let variant: Variant | undefined;
    const timer = new CheckTimer();
    const check = await postWithRetakes(
      async () => {
        const input = await timer.shoot(() => this.#shoot(target, name, options));
        // A retake is the same screen: keep the first screenshot's variant.
        variant ??= input.variant;
        return timer.post(() => client.postCheck(buildId, { ...input, variant }));
      },
      {
        retakes,
        intervalMs: settings.retakeIntervalMs,
      },
    );
    const timing = timer.result();
    this.#behaviour.timings?.add(timing);
    console.info(timingLine(name, check, timing));
    await this.#report(client, check, name, timing);
    if ((options.failOnChange ?? settings.failOnChange) && failsOnChange(check)) {
      throw new PixeltwinCheckError(check, client.checkUrl(check));
    }
    return check;
  }

  /** One screenshot with its ignore regions (screenshot pixels) and variant. */
  async #shoot(target: Page | Locator, name: string, options: CheckOptions): Promise<CheckInput> {
    const page = isPage(target) ? target : target.page();
    const shot = {
      animations: 'disabled' as const,
      caret: 'hide' as const,
      ...options.screenshot,
      mask: options.mask,
    };
    const locators = (options.ignore ?? []).filter(isLocator);
    const rects = (options.ignore ?? []).filter((r): r is Rect => !isLocator(r));

    // Boxes are CSS pixels relative to the viewport; ignore regions are screenshot pixels. The scale
    // comes from the image wherever it can: that covers the device pixel ratio, a phone zoomed out to
    // 980 CSS pixels, `scale: 'css'` and browsers that render a full page differently.
    const metrics = await metricsOf(page);
    const boxes = await boxesOf(locators);
    const assumed = shot.scale === 'css' ? 1 : metrics.dpr;
    const wantElements = options.elements ?? this.#behaviour.settings.elements ?? true;
    let raw: RawElement[] = [];
    let image: Uint8Array;
    let mapping: CssToPixels;
    if (isPage(target)) {
      if (wantElements) {
        // The captured area in viewport CSS pixels, as getBoundingClientRect() measures.
        const clip = options.fullPage
          ? {
              x: -metrics.scrollX + (shot.clip?.x ?? 0),
              y: -metrics.scrollY + (shot.clip?.y ?? 0),
              width: shot.clip?.width ?? metrics.docWidth,
              height: shot.clip?.height ?? metrics.docHeight,
            }
          : (shot.clip ?? null);
        raw = await elementsOf(page, clip, name);
      }
      image = await target.screenshot({ ...shot, fullPage: options.fullPage ?? false });
      const size = pngSize(image);
      if (options.fullPage) {
        // The image covers the whole document (or the clip, in document coordinates); boxes are
        // relative to the viewport, so the origin is minus the scroll offset.
        const width = shot.clip?.width ?? metrics.docWidth;
        const height = shot.clip?.height ?? metrics.docHeight;
        mapping = {
          origin: { x: -metrics.scrollX + (shot.clip?.x ?? 0), y: -metrics.scrollY + (shot.clip?.y ?? 0) },
          scale: fullPageScale(size, width, height, assumed),
        };
      } else {
        const measured = (size?.width ?? 0) / (shot.clip?.width ?? metrics.visibleWidth);
        mapping = {
          origin: { x: shot.clip?.x ?? 0, y: shot.clip?.y ?? 0 },
          scale: measured || assumed * metrics.zoom,
        };
      }
    } else {
      const { clip: _clip, ...locatorShot } = shot;
      const own = await target.boundingBox();
      if (!own) throw new Error(`pixeltwin: "${name}": the element to screenshot is not visible.`);
      if (wantElements) raw = await elementsOf(page, own, name);
      image = await target.screenshot(locatorShot);
      const measured = (pngSize(image)?.width ?? 0) / own.width;
      mapping = { origin: { x: own.x, y: own.y }, scale: measured || assumed };
    }

    const size = pngSize(image);
    const ignoreRegions = [
      ...rects.map((r) => toPixelRect(r, size)),
      ...boxes.map((b) => cssBoxToPixels(b, mapping, size)),
    ].filter((r) => r !== null);

    const viewport = page.viewportSize() ?? { width: metrics.width, height: metrics.height };
    const variant: Variant = {
      browser: this.#browserName,
      viewport: `${viewport.width}x${viewport.height}`,
      ...this.#variant,
      ...options.variant,
    };
    return {
      name,
      image,
      variant,
      ignoreRegions,
      colorThreshold: options.colorThreshold,
      tolerancePercent: options.tolerancePercent,
      reviewWithinTolerance: options.reviewWithinTolerance,
      ...(wantElements ? { elements: elementsToPixels(raw, mapping, size) } : {}),
    };
  }

  /** The annotation and text attachment, the images when it changed, then `pixeltwinOnResult`. */
  async #report(client: PixeltwinClient, check: Check, name: string, timing: CheckTiming): Promise<void> {
    const link = client.checkUrl(check);
    const summary = check.diff && 'summary' in check.diff ? ` — ${check.diff.summary}` : '';
    this.#testInfo.annotations.push({ type: 'pixeltwin', description: `${name}: ${check.result} ${link}` });
    await this.#testInfo.attach(`pixeltwin ${name}`, {
      body: `${check.result}${summary}\n${link}`,
      contentType: 'text/plain',
    });
    let images: Promise<CheckImages> | null = null;
    const load = () => {
      images ??= imagesOf(client, check);
      return images;
    };
    if (this.#behaviour.attachImages && check.result !== 'unchanged') {
      const { baseline, current, diff } = await load();
      const parts: Array<[string, Uint8Array | null]> = [
        ['expected', baseline],
        ['actual', current],
        ['diff', diff],
      ];
      for (const [kind, body] of parts) {
        if (body)
          await this.#testInfo.attach(`pixeltwin ${name} ${kind}`, {
            body: Buffer.from(body),
            contentType: 'image/png',
          });
      }
    }
    await this.#behaviour.onResult?.({ name, check, url: link, testInfo: this.#testInfo, timing, images: load });
  }
}
