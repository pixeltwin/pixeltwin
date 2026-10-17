// Checks the landing page in site/ before it is deployed to GitHub Pages (CI runs it):
//   bun scripts/site-check.ts
// Every local link, image and stylesheet exists, every in-page #link has its target, every <img> has
// alt text and width/height, and what a first visit downloads stays under the page weight budget.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** What the first view may download: the HTML, CSS, JS, favicon and every image not loaded lazily. */
export const FIRST_VIEW_BUDGET = 600 * 1024;
/** The public address the Open Graph tags point at; files under it must exist in site/. */
export const PAGES_URL = 'https://pixeltwin.github.io/pixeltwin/';

export interface SiteReport {
  errors: string[];
  firstViewBytes: number;
  pages: number;
}

const attr = (tag: string, name: string): string | undefined => {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return match ? (match[2] ?? match[3]) : undefined;
};
const hasAttr = (tag: string, name: string) => new RegExp(`\\s${name}(\\s*=|\\s|/?>)`, 'i').test(tag);
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? [];
const isExternal = (url: string) => /^(https?:)?\/\//i.test(url) || /^(mailto|tel|data):/i.test(url);
const srcsetUrls = (srcset: string) =>
  srcset
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);

export function checkSite(siteDir: string): SiteReport {
  const errors: string[] = [];
  const size = (file: string) => (existsSync(file) ? statSync(file).size : 0);
  const pages = readdirSync(siteDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.html'));
  let firstViewBytes = 0;

  for (const page of pages) {
    const file = join(siteDir, page);
    const html = readFileSync(file, 'utf8');
    const where = relative(siteDir, file);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const resolve = (url: string) => join(dirname(file), decodeURI(url.split(/[?#]/)[0] ?? ''));
    const local = (url: string, what: string) => {
      if (isExternal(url)) return;
      if (url.startsWith('/')) {
        errors.push(
          `${where}: ${what} ${url} is root-relative; use a relative URL so the site works under /pixeltwin/`,
        );
        return;
      }
      if (url.startsWith('#')) {
        if (url !== '#' && !ids.has(url.slice(1))) errors.push(`${where}: ${what} ${url} has no element with that id`);
        return;
      }
      const target = resolve(url);
      const path = url.split(/[?#]/)[0] ?? '';
      const exists = path === '' || path.endsWith('/') ? existsSync(join(target, 'index.html')) : existsSync(target);
      if (!exists) errors.push(`${where}: ${what} ${url} does not exist`);
    };

    for (const tag of tags(html, 'a')) {
      const href = attr(tag, 'href');
      if (href === undefined) errors.push(`${where}: <a> without href: ${tag}`);
      else local(href, 'link');
    }
    for (const tag of tags(html, 'link')) {
      const href = attr(tag, 'href');
      if (href) local(href, `<link rel=${attr(tag, 'rel')}>`);
    }
    for (const tag of [...tags(html, 'script'), ...tags(html, 'source'), ...tags(html, 'img')]) {
      const src = attr(tag, 'src');
      if (src) local(src, 'file');
      for (const url of srcsetUrls(attr(tag, 'srcset') ?? '')) local(url, 'srcset file');
    }
    for (const tag of tags(html, 'img')) {
      const name = attr(tag, 'src') ?? tag;
      if (!hasAttr(tag, 'alt')) errors.push(`${where}: <img> ${name} has no alt attribute`);
      for (const dim of ['width', 'height']) {
        if (!/^\d+$/.test(attr(tag, dim) ?? '')) errors.push(`${where}: <img> ${name} has no ${dim}`);
      }
    }
    for (const tag of tags(html, 'meta')) {
      const content = attr(tag, 'content') ?? '';
      if (
        /^(og|twitter):image$/.test(attr(tag, 'property') ?? attr(tag, 'name') ?? '') &&
        content.startsWith(PAGES_URL)
      ) {
        local(content.slice(PAGES_URL.length), `${attr(tag, 'property') ?? attr(tag, 'name')}`);
      }
    }
    if (!/<title>[^<]+<\/title>/.test(html)) errors.push(`${where}: no <title>`);
    if (!/<meta name="description" content="[^"]+"/.test(html)) errors.push(`${where}: no meta description`);
    if (!/<html lang="[^"]+"/.test(html)) errors.push(`${where}: <html> has no lang`);

    // First view: the page, its stylesheets, scripts and icons, and the images not marked loading="lazy".
    // A <picture> downloads one candidate; count its largest, so neither theme can exceed the budget.
    let bytes = size(file);
    for (const tag of tags(html, 'link')) {
      const href = attr(tag, 'href');
      if (href && !isExternal(href) && /stylesheet|icon/.test(attr(tag, 'rel') ?? '')) bytes += size(resolve(href));
    }
    for (const tag of tags(html, 'script')) {
      const src = attr(tag, 'src');
      if (src && !isExternal(src)) bytes += size(resolve(src));
    }
    const pictures = html.match(/<picture\b[\s\S]*?<\/picture>/gi) ?? [];
    const outside = pictures.reduce((rest, picture) => rest.replace(picture, ''), html);
    const largest = (fragment: string) =>
      Math.max(
        0,
        ...[...tags(fragment, 'source'), ...tags(fragment, 'img')].flatMap((tag) =>
          [attr(tag, 'src') ?? '', ...srcsetUrls(attr(tag, 'srcset') ?? '')]
            .filter((url) => url && !isExternal(url))
            .map((url) => size(resolve(url))),
        ),
      );
    for (const picture of pictures) {
      if (attr(tags(picture, 'img')[0] ?? '', 'loading') !== 'lazy') bytes += largest(picture);
    }
    for (const tag of tags(outside, 'img')) {
      if (attr(tag, 'loading') !== 'lazy') bytes += largest(tag);
    }
    if (bytes > FIRST_VIEW_BUDGET) {
      errors.push(`${where}: the first view downloads ${kb(bytes)}, over the budget of ${kb(FIRST_VIEW_BUDGET)}`);
    }
    firstViewBytes += bytes;
  }
  if (pages.length === 0) errors.push(`no .html files in ${siteDir}`);
  return { errors, firstViewBytes, pages: pages.length };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

if (import.meta.main) {
  const siteDir = join(import.meta.dir, '..', 'site');
  const report = checkSite(siteDir);
  for (const error of report.errors) console.error(`✗ ${error}`);
  if (report.errors.length > 0) process.exit(1);
  console.log(
    `✓ site: ${report.pages} page(s), links, images and alt text fine; first view ${kb(report.firstViewBytes)}`,
  );
}
