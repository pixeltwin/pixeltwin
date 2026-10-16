// The WebdriverIO service driven through its hooks with a fake browser, against a real server.
// A real WebdriverIO run needs a driver and a browser download; the service only touches the
// browser through addCommand, execute, takeScreenshot, takeElementScreenshot and capabilities.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { type Check, PixeltwinClient } from '@pixeltwin/client';
import { type BrowserLike, PixeltwinService, SevereServiceError } from '@pixeltwin/wdio';
import { makePng, type Rgba, WHITE } from '../helpers/png';
import { startServer, type TestServer } from './server';

let server: TestServer;
let client: PixeltwinClient;

beforeAll(async () => {
  server = await startServer('wdio');
  client = new PixeltwinClient({ url: server.url, token: server.token });
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

const ENV_KEYS = ['PIXELTWIN_BUILD_ID', 'PIXELTWIN_EXTERNAL_ID', 'PIXELTWIN_DISABLED'];
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

type CommandFn = (this: unknown, name: string, options?: unknown) => Promise<Check | null>;

/**
 * A browser at device pixel ratio 2 showing a 400×300 CSS viewport: a header (0,0 400×40) with a
 * clock (300,10 80×20) that changes on every screenshot, and a button whose colour can change.
 */
function fakeBrowser(button: Rgba = [0, 112, 243, 255]) {
  let tick = 0;
  const elements: Record<string, { x: number; y: number; width: number; height: number }> = {
    header: { x: 0, y: 0, width: 400, height: 40 },
    clock: { x: 300, y: 10, width: 80, height: 20 },
    hidden: { x: 0, y: 0, width: 0, height: 0 },
  };
  const viewport = () => {
    tick++;
    const clock: Rgba = [tick * 40, 0, 0, 255];
    return makePng(800, 600, WHITE, [
      { x: 0, y: 0, width: 800, height: 80, color: [17, 17, 17, 255] },
      { x: 600, y: 20, width: 160, height: 40, color: clock },
      { x: 40, y: 200, width: 200, height: 60, color: button },
    ]);
  };
  const browserCommands: Record<string, CommandFn> = {};
  const elementCommands: Record<string, CommandFn> = {};
  const executed: unknown[][] = [];
  const browser: BrowserLike = {
    capabilities: { browserName: 'chrome' },
    takeScreenshot: async () => Buffer.from(viewport()).toString('base64'),
    takeElementScreenshot: async (id: string) => {
      if (id !== 'header') throw new Error(`no screenshot for ${id}`);
      // The header crop of the viewport, device pixels.
      tick++;
      return Buffer.from(
        makePng(800, 80, [17, 17, 17, 255], [{ x: 600, y: 20, width: 160, height: 40, color: [tick * 40, 0, 0, 255] }]),
      ).toString('base64');
    },
    execute: (async (_script: unknown, ...args: ({ elementId: string } | null)[]) => {
      executed.push(args);
      const box = (e: { elementId: string } | null) => (e ? (elements[e.elementId] ?? null) : null);
      const [target, ...ignored] = args;
      return { width: 400, height: 300, target: box(target ?? null), boxes: ignored.map(box) };
    }) as BrowserLike['execute'],
    addCommand(name, fn, attachToElement) {
      (attachToElement ? elementCommands : browserCommands)[name] = fn as CommandFn;
    },
  };
  const el = (elementId: string) => ({ elementId });
  return {
    browser,
    executed,
    el,
    /** `browser.pixeltwinCheck(...)` */
    check: (name: string, options?: unknown) => browserCommands.pixeltwinCheck?.call(browser, name, options),
    /** `$(id).pixeltwinCheck(...)` */
    checkElement: (id: string, name: string, options?: unknown) =>
      elementCommands.pixeltwinCheck?.call(el(id), name, options),
  };
}

const options = () => ({ url: '', token: '', project: 'wdio', branch: 'main' });

function services(extra: Record<string, unknown> = {}) {
  const opts = { ...options(), url: server.url, token: server.token, ...extra };
  // WebdriverIO makes one instance in the launcher and one per worker, with the same options.
  return { launcher: new PixeltwinService(opts), worker: new PixeltwinService(opts) };
}

describe('PixeltwinService', () => {
  test('one build per run, browser and element checks, ignore regions in device pixels, gate', async () => {
    const run1 = services({ gate: true });
    await run1.launcher.onPrepare({});
    const buildId = process.env.PIXELTWIN_BUILD_ID ?? '';
    expect(buildId).toStartWith('bld_');

    const fake = fakeBrowser();
    run1.worker.before({}, [], fake.browser);
    const page = await fake.check('home', { ignore: [fake.el('clock'), Promise.resolve(fake.el('hidden'))] });
    expect(page?.result).toBe('new');
    expect(page?.variant).toEqual({ browser: 'chrome', viewport: '400x300' });
    expect(page?.ignoreRegions).toEqual([{ x: 600, y: 20, width: 160, height: 40 }]);
    expect(page?.buildId).toBe(buildId);
    const header = await fake.checkElement('header', 'header', {
      ignore: [fake.el('clock')],
      variant: { theme: 'light' },
    });
    expect(header?.variant).toEqual({ browser: 'chrome', viewport: '400x300', theme: 'light' });
    expect(header?.ignoreRegions).toEqual([{ x: 600, y: 20, width: 160, height: 40 }]);
    expect(fake.executed[1]?.[0]).toEqual({ elementId: 'header' }); // the target goes first

    // New checks wait for review: the gate stops the launcher with a severe error.
    const gated = await run1.launcher.onComplete().catch((e) => e);
    expect(gated).toBeInstanceOf(SevereServiceError);
    expect(gated.name).toBe('SevereServiceError');
    expect(gated.message).toContain('"pending", not "passed"');
    expect((await client.getBuild(buildId)).state).toBe('finalized');
    expect(process.env.PIXELTWIN_BUILD_ID).toBeUndefined(); // put back for the next run
    await client.approveBuild(buildId);

    // Run 2: the clock changes on every screenshot but is ignored.
    const run2 = services({ gate: true });
    await run2.launcher.onPrepare({});
    const same = fakeBrowser();
    run2.worker.before({}, [], same.browser);
    expect((await same.check('home', { ignore: [same.el('clock')] }))?.result).toBe('unchanged');
    expect(
      (await same.checkElement('header', 'header', { ignore: [same.el('clock')], variant: { theme: 'light' } }))
        ?.result,
    ).toBe('unchanged');
    await run2.launcher.onComplete();

    // Run 3: the button changed.
    const run3 = services({ gate: true });
    await run3.launcher.onPrepare({});
    const changed = fakeBrowser([229, 72, 77, 255]);
    run3.worker.before({}, [], changed.browser);
    const check = await changed.check('home', { ignore: [changed.el('clock')] });
    expect(check?.result).toBe('changed');
    expect((await run3.launcher.onComplete().catch((e) => e)).message).toContain('not "passed"');
  });

  test('a shard leaves the build open', async () => {
    const shard = services({ externalId: 'wdio-shards-1' });
    await shard.launcher.onPrepare({ shard: { current: 1, total: 2 } });
    const id = process.env.PIXELTWIN_BUILD_ID ?? '';
    const fake = fakeBrowser();
    shard.worker.before({}, [], fake.browser);
    await fake.check('shard');
    await shard.launcher.onComplete();
    expect((await client.getBuild(id)).state).toBe('open');
  });

  test('a bad token stops the launcher; a worker without a build says so; disabled posts nothing', async () => {
    const bad = new PixeltwinService({ ...options(), url: server.url, token: 'pt_wrong', retries: 0 });
    const err = await bad.onPrepare({}).catch((e) => e);
    expect(err).toBeInstanceOf(SevereServiceError);
    expect(err.message).toContain('401');

    const lonely = new PixeltwinService({ ...options(), url: server.url, token: server.token });
    const fake = fakeBrowser();
    lonely.before({}, [], fake.browser);
    expect(await fake.check('home').catch((e: Error) => e.message)).toContain('no build');

    const off = new PixeltwinService({ disabled: true });
    await off.onPrepare({});
    const quiet = fakeBrowser();
    off.before({}, [], quiet.browser);
    expect(await quiet.check('home')).toBeNull();
    await off.onComplete();
    expect(process.env.PIXELTWIN_DISABLED).toBeUndefined();
  });
});
