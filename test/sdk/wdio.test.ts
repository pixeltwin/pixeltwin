// The WebdriverIO service driven through its hooks with a fake browser, against a real server.
// A real WebdriverIO run needs a driver and a browser download; the service only touches the
// browser through addCommand, execute, takeScreenshot, takeElementScreenshot and capabilities.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { type Check, PixeltwinClient } from '@pixeltwin/client';
import {
  type BrowserLike,
  type CheckResultInfo,
  PixeltwinCheckError,
  PixeltwinService,
  SevereServiceError,
} from '@pixeltwin/wdio';
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

const ENV_KEYS = ['PIXELTWIN_BUILD_ID', 'PIXELTWIN_EXTERNAL_ID', 'PIXELTWIN_DISABLED', 'PIXELTWIN_OFFLINE'];
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

type CommandFn = (this: unknown, name: string, options?: unknown) => Promise<Check | null>;

/**
 * A browser at device pixel ratio 2 showing a 400×300 CSS viewport: a header (0,0 400×40) with a
 * clock (300,10 80×20) that changes on every screenshot, and a button whose colour can change.
 */
function fakeBrowser(button: Rgba | ((shot: number) => Rgba) = [0, 112, 243, 255]) {
  let shots = 0;
  let tick = 0;
  const elements: Record<string, { x: number; y: number; width: number; height: number }> = {
    header: { x: 0, y: 0, width: 400, height: 40 },
    clock: { x: 300, y: 10, width: 80, height: 20 },
    hidden: { x: 0, y: 0, width: 0, height: 0 },
  };
  const viewport = () => {
    tick++;
    const color = typeof button === 'function' ? button(shots++) : button;
    const clock: Rgba = [tick * 40, 0, 0, 255];
    return makePng(800, 600, WHITE, [
      { x: 0, y: 0, width: 800, height: 80, color: [17, 17, 17, 255] },
      { x: 600, y: 20, width: 160, height: 40, color: clock },
      { x: 40, y: 200, width: 200, height: 60, color },
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
    // As WebdriverIO 10 does: an options object, and a boolean third argument throws.
    addCommand(name, fn, commandOptions) {
      if (typeof commandOptions === 'boolean') throw new Error('Passing a boolean as the third argument was removed');
      (commandOptions?.attachToElement ? elementCommands : browserCommands)[name] = fn as CommandFn;
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

  test('element arrays ($$ results, awaited or not) are spread into execute arguments', async () => {
    const run = services({ externalId: 'wdio-arrays-1' });
    await run.launcher.onPrepare({});
    const fake = fakeBrowser();
    run.worker.before({}, [], fake.browser);
    const check = await fake.check('arrays', {
      ignore: [Promise.resolve([fake.el('clock'), fake.el('hidden')]), [fake.el('header')]],
    });
    // Element references only work as top-level execute arguments: no nested arrays.
    expect(fake.executed[0]).toEqual([null, { elementId: 'clock' }, { elementId: 'hidden' }, { elementId: 'header' }]);
    expect(check?.ignoreRegions).toEqual([
      { x: 600, y: 20, width: 160, height: 40 },
      { x: 0, y: 0, width: 800, height: 80 },
    ]);
    await run.launcher.onComplete();
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

  describe('retakes, onResult and failOnChange', () => {
    const BLUE: Rgba = [0, 112, 243, 255];
    const RED: Rgba = [229, 72, 77, 255];

    async function baseline(project: string, token: string) {
      const run = services({ project, token });
      await run.launcher.onPrepare({});
      const fake = fakeBrowser(BLUE);
      run.worker.before({}, [], fake.browser);
      await fake.check('home', { ignore: [fake.el('clock')] });
      const id = process.env.PIXELTWIN_BUILD_ID ?? '';
      await run.launcher.onComplete();
      await new PixeltwinClient({ url: server.url, token }).approveBuild(id);
    }

    test('a screenshot that settles is retaken until unchanged; the build keeps one check', async () => {
      const token = await server.newProject('wdio-retakes');
      await baseline('wdio-retakes', token);
      const run = services({ project: 'wdio-retakes', token, retakes: 3, retakeIntervalMs: 10 });
      await run.launcher.onPrepare({});
      // Still loading for the first two screenshots, then the page is as approved.
      const fake = fakeBrowser((shot) => (shot < 2 ? RED : BLUE));
      // The window grows between screenshots (as an element screenshot can leave it): a retake is
      // still the same screen, with the first screenshot's variant.
      const measure = fake.browser.execute;
      let calls = 0;
      fake.browser.execute = (async (...args: Parameters<typeof measure>) => {
        const box = (await measure(...args)) as { height: number };
        return { ...box, height: box.height + 20 * calls++ };
      }) as BrowserLike['execute'];
      run.worker.before({}, [], fake.browser);
      const check = await fake.check('home', { ignore: [fake.el('clock')] });
      expect(check?.result).toBe('unchanged');
      expect(check?.variant).toEqual({ browser: 'chrome', viewport: '400x300' });
      const id = process.env.PIXELTWIN_BUILD_ID ?? '';
      const own = new PixeltwinClient({ url: server.url, token });
      expect((await own.listChecks(id)).items).toHaveLength(1);
      await run.launcher.onComplete();
    });

    test('onResult gets the check and its images; failOnChange throws with the review link', async () => {
      const token = await server.newProject('wdio-fail');
      await baseline('wdio-fail', token);
      const results: CheckResultInfo[] = [];
      const run = services({
        project: 'wdio-fail',
        token,
        failOnChange: true,
        retakes: 1,
        retakeIntervalMs: 10,
        onResult: (r: CheckResultInfo) => {
          results.push(r);
        },
      });
      await run.launcher.onPrepare({});
      const fake = fakeBrowser(RED);
      run.worker.before({}, [], fake.browser);
      const err = await fake.check('home', { ignore: [fake.el('clock')] }).catch((e) => e);
      expect(err).toBeInstanceOf(PixeltwinCheckError);
      expect(err.message).toMatch(/"home" \(chrome, 400x300\) is changed, [\d.]+% of pixels\. Review: http/);
      expect(err.check.result).toBe('changed');
      expect(results.map((r) => [r.name, r.check.result])).toEqual([['home', 'changed']]);
      const images = await results[0]?.images();
      for (const png of [images?.current, images?.baseline, images?.diff]) {
        expect([...(png ?? []).slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
      }
      // A check can opt out.
      expect((await fake.check('home', { ignore: [fake.el('clock')], failOnChange: false }))?.result).toBe('changed');
      await run.launcher.onComplete();
    });

    test('failOnChange passes a new screenshot the project approved automatically', async () => {
      const token = await server.newProject('wdio-auto');
      const patched = await fetch(`${server.url}/api/v1/projects/wdio-auto`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: server.cookie, origin: server.url },
        body: JSON.stringify({ autoApproveNew: true }),
      });
      expect(patched.status).toBe(200);
      const run = services({ project: 'wdio-auto', token, failOnChange: true });
      await run.launcher.onPrepare({});
      const fake = fakeBrowser(RED);
      run.worker.before({}, [], fake.browser);
      expect(await fake.check('home')).toMatchObject({ result: 'new', review: 'approved' });
      await run.launcher.onComplete();
    });
  });

  test('an Appium phone: variant from the capabilities, no DOM, run-wide ignore regions', async () => {
    const run = services({
      externalId: 'wdio-phone-1',
      // iOS status bar and home indicator, in screenshot pixels.
      ignore: ({ width, height }: { width: number; height: number }) => [
        { x: 0, y: 0, width, height: 40 },
        { x: 0, y: height - 30, width, height: 30 },
      ],
      variant: (auto: Record<string, string>) => ({ ...auto, os: auto.os?.toLowerCase() ?? '' }),
    });
    await run.launcher.onPrepare({});
    const fake = fakeBrowser();
    fake.browser.capabilities = {
      platformName: 'iOS',
      'appium:platformVersion': '16.0',
      'appium:deviceName': 'iPhone 13 Pro Max',
    };
    run.worker.before({}, [], fake.browser);
    const check = await fake.check('cart', { ignore: [{ x: 10, y: 100, width: 20, height: 20 }] });
    expect(check?.variant).toEqual({ os: 'ios 16.0', device: 'iPhone 13 Pro Max' });
    expect(fake.executed).toHaveLength(0); // no DOM on a phone
    expect(check?.ignoreRegions).toEqual([
      { x: 10, y: 100, width: 20, height: 20 },
      { x: 0, y: 0, width: 800, height: 40 },
      { x: 0, y: 570, width: 800, height: 30 },
    ]);
    const err = await fake.check('cart', { ignore: [fake.el('clock')] }).catch((e: Error) => e.message);
    expect(err).toContain('ignoring elements needs a desktop browser');
    await run.launcher.onComplete();
  });

  test('allowOffline: a server the run cannot reach lets the tests run; each check says why', async () => {
    const run = services({ token: 'pt_wrong', retries: 0, allowOffline: true });
    await run.launcher.onPrepare({});
    expect(process.env.PIXELTWIN_BUILD_ID).toBeUndefined();
    const fake = fakeBrowser();
    run.worker.before({}, [], fake.browser);
    const err = await fake.check('home').catch((e: Error) => e.message);
    expect(err).toContain('no build for this run');
    expect(err).toContain('401');
    await run.launcher.onComplete();
  });
});
