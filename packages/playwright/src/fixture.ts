import { type Check, type PixeltwinClient, pngSize, type Rect, toPixelRect, type Variant } from '@pixeltwin/client';
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
  /** Other Playwright screenshot options. `animations` defaults to `disabled`, `caret` to `hide`. */
  screenshot?: ScreenshotOptions;
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
  }));
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

  constructor(client: PixeltwinClient | null, testInfo: TestInfo, browserName: string, variant: Variant) {
    this.client = client;
    this.#testInfo = testInfo;
    this.#browserName = browserName;
    this.#variant = variant;
  }

  /** The run's build (set by `@pixeltwin/playwright/setup`); undefined when disabled. */
  get buildId(): string | undefined {
    return process.env.PIXELTWIN_BUILD_ID || undefined;
  }

  /**
   * Screenshots a page or an element and posts it as check `name`. Resolves to the compared check;
   * a `changed` or `new` result does not fail the test (the build verdict decides at the end).
   * Null when pixeltwin is disabled.
   */
  async check(target: Page | Locator, name: string, options: CheckOptions = {}): Promise<Check | null> {
    if (!this.client) return null;
    const buildId = this.buildId;
    if (!buildId) {
      throw new Error(
        "pixeltwin: no build for this run. Add globalSetup: '@pixeltwin/playwright/setup' " +
          "(or wrap the config in withPixeltwin from '@pixeltwin/playwright/config').",
      );
    }
    const page = isPage(target) ? target : target.page();
    const shot = {
      animations: 'disabled' as const,
      caret: 'hide' as const,
      ...options.screenshot,
      mask: options.mask,
    };
    const locators = (options.ignore ?? []).filter(isLocator);
    const rects = (options.ignore ?? []).filter((r): r is Rect => !isLocator(r));

    // Boxes are CSS pixels relative to the viewport; ignore regions are screenshot pixels. For the
    // viewport and for elements the scale comes from the image (it covers the device pixel ratio,
    // a phone zoomed out to 980 CSS pixels and `scale: 'css'`).
    const metrics = await metricsOf(page);
    const boxes = await boxesOf(locators);
    let image: Uint8Array;
    let origin: { x: number; y: number };
    let scale: number;
    if (isPage(target)) {
      image = await target.screenshot({ ...shot, fullPage: options.fullPage ?? false });
      if (options.fullPage) {
        // Chromium renders a full page unzoomed, at the device pixel ratio.
        origin = { x: -metrics.scrollX, y: -metrics.scrollY };
        scale = shot.scale === 'css' ? 1 : metrics.dpr;
      } else {
        origin = { x: 0, y: 0 };
        scale = (pngSize(image)?.width ?? 0) / (shot.clip?.width ?? metrics.visibleWidth);
        scale ||= (shot.scale === 'css' ? 1 : metrics.dpr) * metrics.zoom;
      }
      if (shot.clip) origin = { x: origin.x + shot.clip.x, y: origin.y + shot.clip.y };
    } else {
      const { clip: _clip, ...locatorShot } = shot;
      const own = await target.boundingBox();
      if (!own) throw new Error(`pixeltwin: "${name}": the element to screenshot is not visible.`);
      origin = { x: own.x, y: own.y };
      image = await target.screenshot(locatorShot);
      scale = (pngSize(image)?.width ?? 0) / own.width || metrics.dpr;
    }

    const size = pngSize(image);
    const ignoreRegions = [
      ...rects,
      ...boxes.map((b) => ({
        x: (b.x - origin.x) * scale,
        y: (b.y - origin.y) * scale,
        width: b.width * scale,
        height: b.height * scale,
      })),
    ]
      .map((r) => toPixelRect(r, size))
      .filter((r) => r !== null);

    const viewport = page.viewportSize() ?? { width: metrics.width, height: metrics.height };
    const variant: Variant = {
      browser: this.#browserName,
      viewport: `${viewport.width}x${viewport.height}`,
      ...this.#variant,
      ...options.variant,
    };
    const check = await this.client.postCheck(buildId, {
      name,
      image,
      variant,
      ignoreRegions,
      colorThreshold: options.colorThreshold,
      tolerancePercent: options.tolerancePercent,
    });

    const link = this.client.checkUrl(check);
    const summary = check.diff && 'summary' in check.diff ? ` — ${check.diff.summary}` : '';
    this.#testInfo.annotations.push({ type: 'pixeltwin', description: `${name}: ${check.result} ${link}` });
    await this.#testInfo.attach(`pixeltwin ${name}`, {
      body: `${check.result}${summary}\n${link}`,
      contentType: 'text/plain',
    });
    return check;
  }
}
