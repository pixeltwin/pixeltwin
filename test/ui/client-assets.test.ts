import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { APP_CSS } from '../../src/ui/assets';
import { CLIENT_MODULES, CLIENT_VERSION, clientModulePath } from '../../src/ui/client-assets';
import { createTestApp, type TestApp } from '../helpers/app';
import { html } from '../helpers/ui';

describe('client modules', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  test('every page loads the boot module as an ES module and says where the app lives', async () => {
    const page = await html(await t.request('GET', '/ui/login'));
    expect(page).toContain(`<script type="module" src="/ui/assets/boot.js?v=${CLIENT_VERSION}"></script>`);
    expect(page).toContain('data-base=""');
    expect(page).toContain('<div class="toasts" aria-live="polite" data-toasts=""></div>');
  });

  test('modules are served as JavaScript, cached forever only under the current version', async () => {
    const current = await t.request('GET', clientModulePath('boot'));
    expect(current.status).toBe(200);
    expect(current.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(current.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(current.headers.get('set-cookie')).toBeNull();

    const stale = await t.request('GET', '/ui/assets/boot.js?v=000000000000');
    expect(stale.headers.get('cache-control')).toBe('no-store');
    expect(await stale.text()).toBe(await current.text());

    expect((await t.request('GET', '/ui/assets/nope.js')).status).toBe(404);
    expect((await t.request('GET', '/ui/assets/..%2Fsession.js')).status).toBe(404);
  });

  test('served modules are plain JavaScript whose relative imports point at served modules', () => {
    const js = new Bun.Transpiler({ loader: 'js' });
    for (const [name, code] of Object.entries(CLIENT_MODULES)) {
      expect(() => js.scan(code)).not.toThrow();
      for (const { path } of js.scanImports(code)) {
        const match = /^\.\/([a-z0-9-]+)\.js\?v=([0-9a-f]+)$/.exec(path);
        expect({ name, path, ok: match !== null }).toEqual({ name, path, ok: true });
        expect(Object.keys(CLIENT_MODULES)).toContain(match?.[1] as string);
        expect(match?.[2]).toBe(CLIENT_VERSION);
      }
    }
  });

  test('client JS stays under 30 KB and CSS under 20 KB, gzipped (UI spec §6.2)', () => {
    const gz = (text: string) => Bun.gzipSync(new TextEncoder().encode(text)).length;
    const js = Object.values(CLIENT_MODULES).reduce((sum, code) => sum + gz(code), 0);
    expect(js).toBeLessThan(30 * 1024);
    expect(gz(APP_CSS)).toBeLessThan(20 * 1024);
  });
});
