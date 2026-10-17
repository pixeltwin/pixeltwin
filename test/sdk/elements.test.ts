// collectElements runs in a real Chromium: keys, roles, text, styles and what it leaves out.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { collectElements, elementsToPixels, MAX_ELEMENTS, type RawElement } from '@pixeltwin/client';
import { type Browser, chromium, type Page } from '@playwright/test';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function collect(html: string, clip: { x: number; y: number; width: number; height: number } | null = null) {
  await page.setContent(`<!doctype html><html><body style="margin:0;font:16px sans-serif">${html}</body></html>`);
  return page.evaluate(collectElements, { clip, max: MAX_ELEMENTS });
}

const byKey = (elements: RawElement[], key: string) => elements.find((e) => e.key === key);

describe('collectElements', () => {
  test('keys: test id, stable id, role and name, else a CSS path; the most telling first', async () => {
    const elements = await collect(`
      <main>
        <h1 style="color:#222">Sign in</h1>
        <p>Welcome back</p>
        <label for="email">Email</label><input id="email" value="secret@example.com">
        <button data-testid="submit" style="background:#0070f3;color:#fff">Send</button>
        <a href="/help">Help</a>
        <div id=":r1:">generated id</div>
      </main>`);
    expect(elements[0]?.key).toBe('[data-testid=submit]');
    expect(byKey(elements, '[data-testid=submit]')).toMatchObject({
      tag: 'button',
      role: 'button',
      name: 'Send',
      text: 'Send',
      style: { color: '#ffffff', background: '#0070f3', fontSize: '13.3333px' },
    });
    expect(byKey(elements, '#email')).toMatchObject({ tag: 'input', role: 'textbox', name: 'Email' });
    // What someone typed is never sent.
    expect(JSON.stringify(elements)).not.toContain('secret@example.com');
    expect(byKey(elements, 'role=heading[name="Sign in"]')).toMatchObject({ tag: 'h1', path: 'main > h1' });
    expect(byKey(elements, 'role=link[name="Help"]')).toBeDefined();
    // Text of its own, no role: a CSS path. A generated id is not a key.
    expect(byKey(elements, 'main > p')).toMatchObject({ text: 'Welcome back' });
    expect(elements.find((e) => e.text === 'generated id')?.key).toBe('main > div');
  });

  test('a repeated key gets its position; text inside a control is not listed twice', async () => {
    const elements = await collect(`
      <div data-testid="card">One</div><div data-testid="card">Two</div>
      <button><span>Buy</span></button>`);
    expect(elements.map((e) => e.key)).toEqual([
      '[data-testid=card]',
      '[data-testid=card] >> nth=1',
      'role=button[name="Buy"]',
    ]);
  });

  test('only visible elements in the captured area', async () => {
    const elements = await collect(`
      <header style="height:50px"><b>Logo</b></header>
      <p style="visibility:hidden">hidden</p>
      <p style="opacity:0">transparent</p>
      <p style="display:none">gone</p>
      <p style="margin-top:900px">below the fold</p>`);
    const texts = elements.map((e) => e.text);
    expect(texts).toContain('Logo');
    for (const t of ['hidden', 'transparent', 'gone', 'below the fold']) expect(texts).not.toContain(t);
    const inHeader = await collect('<header style="height:50px"><b>Logo</b></header><p>Text</p>', {
      x: 0,
      y: 0,
      width: 800,
      height: 50,
    });
    expect(inHeader.map((e) => [e.tag, e.text])).toEqual([
      ['header', undefined], // a container's text is its own; its children have theirs
      ['b', 'Logo'],
    ]);
  });

  test('at most `max`, test ids first', async () => {
    await page.setContent(
      `<body>${Array.from({ length: 50 }, (_, i) => `<p>p${i}</p>`).join('')}<i data-testid="x">x</i></body>`,
    );
    const clip = { x: 0, y: 0, width: 800, height: 10_000 };
    const elements = await page.evaluate(collectElements, { clip, max: 5 });
    expect(elements).toHaveLength(5);
    expect(elements[0]?.key).toBe('[data-testid=x]');
  });
});

describe('elementsToPixels', () => {
  test('maps boxes like ignore boxes, rounds edges to whole pixels and drops what is outside the image', () => {
    const raw: RawElement[] = [
      { key: 'a', tag: 'div', x: 10.4, y: 155.6, width: 120, height: 36 },
      { key: 'b', tag: 'div', x: 900, y: 0, width: 10, height: 10, text: '', style: { color: undefined } },
    ];
    const out = elementsToPixels(raw, { origin: { x: 0, y: 0 }, scale: 2 }, { width: 1600, height: 1200 });
    expect(out).toEqual([{ key: 'a', tag: 'div', x: 21, y: 311, width: 240, height: 72 }]);
  });
});
