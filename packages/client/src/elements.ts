// Page elements sent with a screenshot, so pixeltwin can say which element changed and how
// ("`button[data-testid=submit]` moved 4 px down") instead of only where pixels differ.
import { type CssToPixels, toPixelRect } from './png.js';
import type { PageElement, Rect } from './types.js';

/** At most this many elements per screenshot (the server's limit too): the most telling first. */
export const MAX_ELEMENTS = 300;
/** Elements are dropped from the end (the least telling) while their JSON is longer than this. */
export const MAX_ELEMENTS_JSON = 200_000;

/** An element as `collectElements` measures it: its box in CSS pixels relative to the viewport. */
export type RawElement = PageElement;

export interface CollectOptions {
  /** The captured area in CSS pixels relative to the viewport; the viewport when null. */
  clip: Rect | null;
  max: number;
}

/**
 * Runs in the browser (it is serialized, so it uses nothing from outside its body): the meaningful
 * visible elements in the captured area, most telling first. Meaningful: a test id, a stable id, a
 * role (explicit or implicit: links, buttons, headings, form fields, images, landmarks…) or text
 * of its own. Each gets a deterministic key: `[data-testid=…]`, `#id`, `role=button[name="…"]`,
 * else a CSS path; a key that repeats gets ` >> nth=<n>` (Playwright's syntax) from its second use.
 */
export function collectElements(options: CollectOptions): RawElement[] {
  const TEST_IDS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'WBR']);
  const ROLES: Record<string, string> = {
    BUTTON: 'button',
    SUMMARY: 'button',
    H1: 'heading',
    H2: 'heading',
    H3: 'heading',
    H4: 'heading',
    H5: 'heading',
    H6: 'heading',
    NAV: 'navigation',
    MAIN: 'main',
    HEADER: 'banner',
    FOOTER: 'contentinfo',
    ASIDE: 'complementary',
    FORM: 'form',
    IMG: 'img',
    SVG: 'img',
    CANVAS: 'img',
    VIDEO: 'video',
    SELECT: 'combobox',
    TEXTAREA: 'textbox',
    UL: 'list',
    OL: 'list',
    LI: 'listitem',
    TABLE: 'table',
    DIALOG: 'dialog',
    PROGRESS: 'progressbar',
  };
  const INPUT_ROLES: Record<string, string> = {
    checkbox: 'checkbox',
    radio: 'radio',
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    range: 'slider',
    search: 'searchbox',
  };
  /** Roles whose accessible name is their text. */
  const NAMED_BY_TEXT = new Set(['button', 'link', 'heading', 'tab', 'menuitem', 'option', 'cell', 'listitem']);
  const IN_CONTROL =
    'a,button,label,summary,h1,h2,h3,h4,h5,h6,[role=button],[role=link],[role=heading],[role=tab],[role=menuitem],[role=option]';

  const clean = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const quote = (v: string) => (/^[A-Za-z_][\w-]*$/.test(v) ? v : JSON.stringify(v));
  const hex = (color: string): string | undefined => {
    const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\)/.exec(color);
    if (!m) return color || undefined;
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
    if (alpha === 0) return undefined;
    const part = (v: number) => Math.round(v).toString(16).padStart(2, '0');
    const rgb = `#${part(Number(m[1]))}${part(Number(m[2]))}${part(Number(m[3]))}`;
    return alpha < 1 ? `${rgb}${part(alpha * 255)}` : rgb;
  };
  // Ids that frameworks generate (`:r1:`, `ember123`, `mui-42`, hashes) change between runs.
  const stableId = (id: string) =>
    !!id &&
    !/^(?:[:\d]|ember|react-|mui-|radix-|headlessui-)|\d{4,}|[0-9a-f]{8,}/i.test(id) &&
    document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
  const roleOf = (el: Element): string | undefined => {
    const explicit = clean(el.getAttribute('role')).split(' ')[0];
    if (explicit) return explicit;
    if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : undefined;
    if (el.tagName === 'INPUT') return INPUT_ROLES[(el as HTMLInputElement).type] ?? 'textbox';
    return ROLES[el.tagName.toUpperCase()];
  };
  const nameOf = (el: Element, role: string | undefined): string => {
    const label = clean(el.getAttribute('aria-label'));
    if (label) return label;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const text = clean(
        by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
      if (text) return text;
    }
    if (el.tagName === 'IMG') return clean(el.getAttribute('alt'));
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const field = el as HTMLInputElement;
      const own = field.labels?.[0]?.textContent;
      if (own) return clean(own);
      if (['button', 'submit', 'reset'].includes(field.type)) return clean(field.value);
      return clean(field.getAttribute('placeholder') ?? el.getAttribute('title'));
    }
    if (role && NAMED_BY_TEXT.has(role)) return clean(el.textContent);
    return clean(el.getAttribute('title'));
  };
  const ownText = (el: Element) => {
    let text = '';
    for (const node of el.childNodes) if (node.nodeType === 3) text += node.textContent ?? '';
    return clean(text);
  };
  const segment = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    const same = [...parent.children].filter((c) => c.tagName === el.tagName);
    return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag;
  };
  const pathOf = (el: Element) => {
    const parts: string[] = [];
    let at: Element | null = el;
    while (at && at !== document.body && at !== document.documentElement) {
      if (at !== el && at.id && stableId(at.id)) {
        parts.unshift(`#${CSS.escape(at.id)}`);
        break;
      }
      parts.unshift(segment(at));
      at = at.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  };

  const clip = options.clip ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  const found: Array<{ el: Element; order: number; rank: number; box: DOMRect; testId: string | null }> = [];
  const all = document.body ? document.body.querySelectorAll('*') : [];
  let order = 0;
  for (const el of all) {
    order += 1;
    if (SKIP.has(el.tagName.toUpperCase())) continue;
    // Inside an SVG only the SVG itself counts.
    if (el instanceof SVGElement && el.tagName.toUpperCase() !== 'SVG') continue;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) continue;
    if (box.right <= clip.x || box.bottom <= clip.y || box.left >= clip.x + clip.width) continue;
    if (box.top >= clip.y + clip.height) continue;
    const testAttr = TEST_IDS.find((a) => el.hasAttribute(a));
    const testId = testAttr ? `[${testAttr}=${quote(el.getAttribute(testAttr) ?? '')}]` : null;
    const role = roleOf(el);
    let rank: number;
    if (testId) rank = 0;
    else if (el.id && stableId(el.id)) rank = 1;
    else if (role) rank = 2;
    else if (ownText(el) && !el.parentElement?.closest(IN_CONTROL)) rank = 3;
    else continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) continue;
    found.push({ el, order, rank, box, testId });
  }
  found.sort((a, b) => a.rank - b.rank || a.order - b.order);
  const chosen = found.slice(0, options.max);

  const out = chosen.map(({ el, box, testId }) => {
    const role = roleOf(el);
    const name = cut(nameOf(el, role), 80);
    const path = pathOf(el);
    let key = testId ?? '';
    if (!key && el.id && stableId(el.id)) key = `#${CSS.escape(el.id)}`;
    if (!key && role && name) key = `role=${role}[name=${JSON.stringify(name)}]`;
    if (!key) key = path;
    const isField = el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA';
    // Never what someone typed into a field: only the text the page itself shows.
    const text = isField ? '' : cut(clean(el.textContent), 80);
    const style = getComputedStyle(el);
    const element: RawElement = {
      key,
      path: path.length <= 300 ? path : undefined,
      tag: el.tagName.toLowerCase(),
      role,
      name: name || undefined,
      text: text || undefined,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      style: {
        color: hex(style.color),
        background: hex(style.backgroundColor),
        fontSize: style.fontSize || undefined,
      },
    };
    return element;
  });
  // A key used again (a list of cards with one test id) gets its position among the uses.
  const uses = new Map<string, number>();
  const byOrder = out.map((e, i) => ({ e, order: chosen[i]?.order ?? 0 })).sort((a, b) => a.order - b.order);
  for (const { e } of byOrder) {
    const n = uses.get(e.key) ?? 0;
    uses.set(e.key, n + 1);
    if (n > 0) e.key = `${e.key} >> nth=${n}`;
  }
  return out;
}

/** Drops empty values so the JSON stays small. */
function compact(e: PageElement): PageElement {
  const out: PageElement = {
    key: e.key.slice(0, 300),
    tag: e.tag.slice(0, 40),
    x: e.x,
    y: e.y,
    width: e.width,
    height: e.height,
  };
  if (e.path) out.path = e.path;
  if (e.role) out.role = e.role.slice(0, 40);
  if (e.name) out.name = e.name.slice(0, 120);
  if (e.text) out.text = e.text.slice(0, 120);
  const style = Object.fromEntries(Object.entries(e.style ?? {}).filter(([, v]) => v));
  if (Object.keys(style).length > 0) out.style = style;
  return out;
}

/**
 * A box in CSS pixels to screenshot pixels, each edge rounded to the nearest pixel (an ignore box
 * rounds outwards; an element's box must keep its size wherever it lands), clipped to the image.
 */
function boxToPixels(box: Rect, { origin, scale }: CssToPixels, image: { width: number; height: number } | null) {
  const sx = typeof scale === 'number' ? scale : scale.x;
  const sy = typeof scale === 'number' ? scale : scale.y;
  const left = Math.round((box.x - origin.x) * sx);
  const top = Math.round((box.y - origin.y) * sy);
  const right = Math.round((box.x + box.width - origin.x) * sx);
  const bottom = Math.round((box.y + box.height - origin.y) * sy);
  return toPixelRect({ x: left, y: top, width: right - left, height: bottom - top }, image);
}

/**
 * The elements in screenshot pixels, clipped to the image; those outside it are dropped. At most
 * MAX_ELEMENTS, and their JSON at most MAX_ELEMENTS_JSON.
 */
export function elementsToPixels(
  raw: RawElement[],
  mapping: CssToPixels,
  image: { width: number; height: number } | null,
): PageElement[] {
  const out: PageElement[] = [];
  let size = 2;
  for (const element of raw) {
    if (out.length >= MAX_ELEMENTS) break;
    const box = boxToPixels(element, mapping, image);
    if (!box) continue;
    const mapped = compact({ ...element, ...box });
    size += JSON.stringify(mapped).length + 1;
    if (size > MAX_ELEMENTS_JSON) break;
    out.push(mapped);
  }
  return out;
}
