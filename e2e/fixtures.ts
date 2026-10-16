import { test as base, type Page } from '@playwright/test';
import { makePng, WHITE } from '../test/helpers/png';

export const ADMIN = 'admin@e2e.test';
export const REVIEWER = 'reviewer@e2e.test';
export const PASSWORD = 'pixeltwin-e2e-password';

/** JSON calls to /api/v1 as a logged-in user or with a project token. */
export class Api {
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}/api/v1${path}`, {
      method,
      headers: body === undefined ? this.headers : { ...this.headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async check(buildId: string, name: string, png: Uint8Array<ArrayBuffer>): Promise<{ id: string; result: string }> {
    const form = new FormData();
    form.set('image', new Blob([png], { type: 'image/png' }), `${name}.png`);
    form.set('meta', JSON.stringify({ name, variant: { browser: 'chromium' } }));
    const res = await fetch(`${this.url}/api/v1/builds/${buildId}/checks`, {
      method: 'POST',
      headers: this.headers,
      body: form,
    });
    if (!res.ok) throw new Error(`posting ${name} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as { id: string; result: string };
  }
}

export async function sessionCookie(url: string, email: string): Promise<string> {
  const res = await fetch(`${url}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login as ${email} → ${res.status}`);
  return /pt_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
}

/** A project of its own per test: build #2 has a changed, a new and an unchanged check. */
export interface Seeded {
  slug: string;
  name: string;
  ci: Api;
  buildId: string;
  changed: string;
  fresh: string;
  same: string;
}

/** A small "web page": a dark header, a heading and a button whose colour and width we vary. */
export function screenshot(
  button: [number, number, number] = [0, 112, 243],
  buttonWidth = 90,
): Uint8Array<ArrayBuffer> {
  return makePng(480, 300, WHITE, [
    { x: 0, y: 0, width: 480, height: 60, color: [17, 17, 17, 255] },
    { x: 40, y: 100, width: 240, height: 24, color: [60, 60, 60, 255] },
    { x: 40, y: 140, width: 400, height: 10, color: [200, 200, 200, 255] },
    { x: 40, y: 220, width: buttonWidth, height: 30, color: [...button, 255] },
  ]);
}

/** Session cookies of the admin and the reviewer, one login each per worker. */
export interface Sessions {
  admin: string;
  reviewer: string;
}

export const test = base.extend<
  { seeded: Seeded; reviewerPage: Page; adminPage: Page },
  { sessions: Sessions; admin: Api }
>({
  // Logging in once per worker keeps the suite under the login limit (10 a minute per email).
  sessions: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
    async ({}, use, workerInfo) => {
      const url = workerInfo.project.use.baseURL as string;
      await use({ admin: await sessionCookie(url, ADMIN), reviewer: await sessionCookie(url, REVIEWER) });
    },
    { scope: 'worker' },
  ],

  admin: [
    async ({ sessions }, use, workerInfo) => {
      const url = workerInfo.project.use.baseURL as string;
      await use(new Api(url, { cookie: `pt_session=${sessions.admin}`, origin: url }));
    },
    { scope: 'worker' },
  ],

  seeded: async ({ admin }, use) => {
    const slug = `e2e-${Math.random().toString(36).slice(2, 10)}`;
    const name = `Shop ${slug.slice(4)}`;
    await admin.call('POST', '/projects', { slug, name });
    const { token } = await admin.call<{ token: string }>('POST', `/projects/${slug}/tokens`, {
      name: 'e2e',
      scopes: ['read', 'write', 'review'],
    });
    const ci = new Api(admin.url, { authorization: `Bearer ${token}` });

    // Build #1 sets the baselines.
    const first = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
    await ci.check(first.id, 'home', screenshot());
    await ci.check(first.id, 'footer', screenshot());
    await ci.call('POST', `/builds/${first.id}/approve`);
    await ci.call('POST', `/builds/${first.id}/finalize`);

    // Build #2: home changed (red, wider button), cart is new, footer unchanged.
    const second = await ci.call<{ id: string }>('POST', `/projects/${slug}/builds`, { branch: 'main' });
    const changed = await ci.check(second.id, 'home', screenshot([229, 72, 77], 130));
    const fresh = await ci.check(second.id, 'cart', screenshot());
    const same = await ci.check(second.id, 'footer', screenshot());
    await ci.call('POST', `/builds/${second.id}/finalize`);
    await use({ slug, name, ci, buildId: second.id, changed: changed.id, fresh: fresh.id, same: same.id });
  },

  reviewerPage: async ({ page, baseURL, sessions }, use) => {
    await page.context().addCookies([{ name: 'pt_session', value: sessions.reviewer, url: baseURL as string }]);
    await use(page);
  },

  adminPage: async ({ page, baseURL, sessions }, use) => {
    await page.context().addCookies([{ name: 'pt_session', value: sessions.admin, url: baseURL as string }]);
    await use(page);
  },
});

export { expect } from '@playwright/test';

/** Opens a UI page and waits until its client islands are listening for keys and clicks. */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.locator('body[data-ready]').waitFor({ state: 'attached' });
}
