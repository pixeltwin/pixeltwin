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

  // Islands load per page (boot.ts imports the ones in `data-islands`, the palette on first use),
  // so the budget is what one page downloads: boot, its islands, the palette and every module they
  // import. Island lists are read from the pages' source, conditional ones included (worst case).
  test('client JS a page loads stays under 30 KB and CSS under 20 KB, gzipped (UI spec §6.2)', async () => {
    const gz = (text: string) => Bun.gzipSync(new TextEncoder().encode(text)).length;
    const js = new Bun.Transpiler({ loader: 'js' });
    const closure = (roots: string[]) => {
      const seen = new Set<string>();
      const todo = [...roots];
      while (todo.length > 0) {
        const name = todo.pop() as string;
        if (seen.has(name)) continue;
        expect(Object.keys(CLIENT_MODULES)).toContain(name);
        seen.add(name);
        for (const { path } of js.scanImports(CLIENT_MODULES[name] as string)) {
          const match = /^\.\/([a-z0-9-]+)\.js\?/.exec(path);
          if (match) todo.push(match[1] as string);
        }
      }
      return seen;
    };
    const pages: Record<string, string[]> = {};
    for (const file of new Bun.Glob('*.tsx').scanSync({
      cwd: `${import.meta.dir}/../../src/ui/pages`,
      absolute: true,
    })) {
      const source = await Bun.file(file).text();
      for (const [i, block] of [...source.matchAll(/islands=\{\[([\s\S]*?)\]\}/g)].entries())
        pages[`${file.split('/').pop()}#${i}`] = [
          // Island names are the strings in its array literals (not `state === 'open'`).
          ...`[${block[1]}`.replace(/\/\/.*/g, '').matchAll(/(?<=[[,]\s*)'([a-z-]+)'/g),
        ].map((m) => m[1] as string);
    }
    // The build page and the check page at least: a pattern that stops matching fails here.
    expect(Object.values(pages)).toContainEqual(['live', 'thumbs', 'grid']);
    expect(Object.values(pages)).toContainEqual(['review']);
    const loaded = new Set<string>();
    const sizes: Record<string, number> = {};
    for (const [page, islands] of Object.entries(pages)) {
      const modules = closure(['boot', 'palette', ...islands]);
      for (const name of modules) loaded.add(name);
      sizes[page] = [...modules].reduce((sum, name) => sum + gz(CLIENT_MODULES[name] as string), 0);
    }
    // Every module is counted on some page: none is loaded some other way, outside the budget.
    expect([...loaded].sort()).toEqual(Object.keys(CLIENT_MODULES).sort());
    for (const [page, size] of Object.entries(sizes))
      expect({ page, size, ok: size < 30 * 1024 }).toEqual({ page, size, ok: true });
    expect(gz(APP_CSS)).toBeLessThan(20 * 1024);
  });
});
