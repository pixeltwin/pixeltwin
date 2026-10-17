import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createProject } from '../../src/domain/projects';
import { createTestApp, type TestApp } from '../helpers/app';
import { BLACK, makePng, WHITE } from '../helpers/png';

const b64 = (png: Uint8Array) => Buffer.from(png).toString('base64');
const plain = makePng(120, 80);
const ticked = makePng(120, 80, WHITE, [{ x: 90, y: 4, width: 20, height: 8, color: BLACK }]);

interface HistoryJson {
  branch: string;
  name: string;
  flaky: { flips: number; unstableArea: { x: number; y: number; width: number; height: number } } | null;
  items: Array<{ checkId: string; result: string }>;
}

describe('flaky screen routes', () => {
  let t: TestApp;
  let ci: { token: string };
  let last: string;

  beforeEach(async () => {
    t = await createTestApp();
    await createProject(t.deps, { slug: 'web', name: 'Web' });
    ci = await t.tokenAs('web', ['read', 'write', 'review']);
    // A clock that ticks every other run; nobody approves it.
    for (const [i, png] of [plain, ticked, plain, ticked, plain].entries()) {
      const build = (await (await t.request('POST', '/api/v1/projects/web/builds', { as: ci, json: {} })).json()) as {
        id: string;
      };
      const res = await t.request('POST', `/api/v1/builds/${build.id}/checks`, {
        as: ci,
        json: { name: 'home', imageBase64: b64(png) },
      });
      last = ((await res.json()) as { id: string }).id;
      if (i === 0) await t.request('POST', `/api/v1/checks/${last}/approve`, { as: ci });
    }
  });

  afterEach(async () => {
    await t.close();
  });

  test("a check's history says its screen is flaky and where; the project lists its noisy screens", async () => {
    const res = await t.request('GET', `/api/v1/checks/${last}/history`, { as: ci });
    expect(res.status).toBe(200);
    const history = (await res.json()) as HistoryJson;
    expect(history.items).toHaveLength(5);
    expect(history.items[0]).toMatchObject({ checkId: last, result: 'unchanged' });
    expect(history.flaky).toMatchObject({ flips: 3, unstableArea: { x: 90, y: 4, width: 20, height: 8 } });

    const noisy = (await (await t.request('GET', '/api/v1/projects/web/noisy-screens', { as: ci })).json()) as {
      items: HistoryJson[];
    };
    expect(noisy.items.map((s) => [s.name, s.branch])).toEqual([['home', 'main']]);

    // Ignoring the unstable area takes care of the screen.
    const area = history.flaky?.unstableArea;
    await t.request('POST', `/api/v1/checks/${last}/areas`, { as: ci, json: { kind: 'ignore', ...area } });
    const after = (await (await t.request('GET', `/api/v1/checks/${last}/history`, { as: ci })).json()) as HistoryJson;
    expect(after.flaky).toBeNull();
    const none = (await (await t.request('GET', '/api/v1/projects/web/noisy-screens', { as: ci })).json()) as {
      items: unknown[];
    };
    expect(none.items).toEqual([]);
  });
});
