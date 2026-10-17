import { describe, expect, test } from 'bun:test';
import { type Check, CheckTimer, formatMs, TimingTotals, timingLine } from '@pixeltwin/client';

const check = (over: Partial<Check> = {}) => ({ name: 'home', result: 'unchanged', compareMs: 40, ...over }) as Check;

describe('timing', () => {
  test('a check timer splits each take into screenshot, upload and compare, and counts retakes', async () => {
    let now = 0;
    const timer = new CheckTimer(() => now);
    for (const take of [check({ result: 'changed' }), check()]) {
      await timer.shoot(async () => {
        now += 300;
      });
      await timer.post(async () => {
        now += 100;
        return take;
      });
    }
    // Each post took 100 ms, 40 of them on the server.
    expect(timer.result()).toEqual({ screenshotMs: 600, uploadMs: 120, compareMs: 80, retakes: 1, totalMs: 800 });
  });

  test('worker totals are sent once, and only when there is something to send', async () => {
    const sent: unknown[] = [];
    const client = { addTimings: async (buildId: string, t: unknown) => void sent.push([buildId, t]) };
    const totals = new TimingTotals();
    await totals.flush(client, 'bld_1');
    expect(sent).toEqual([]);
    totals.add({ screenshotMs: 600, uploadMs: 120, compareMs: 80, retakes: 1, totalMs: 800 });
    totals.add({ screenshotMs: 200, uploadMs: 30, compareMs: 20, retakes: 0, totalMs: 250 });
    await totals.flush(client, 'bld_1');
    await totals.flush(client, 'bld_1');
    expect(sent).toEqual([['bld_1', { checks: 2, screenshotMs: 800, uploadMs: 150, retakes: 1 }]]);
  });

  test('durations read like a person says them; a check gets one log line', () => {
    expect([formatMs(40), formatMs(1400), formatMs(38_000), formatMs(171_000), formatMs(3_725_000)]).toEqual([
      '0.04 s',
      '1.4 s',
      '38 s',
      '2m 51s',
      '1h 2m',
    ]);
    expect(
      timingLine('home', check({ result: 'changed' }), {
        screenshotMs: 300,
        uploadMs: 200,
        compareMs: 900,
        retakes: 1,
        totalMs: 1400,
      }),
    ).toBe('pixeltwin: "home" changed in 1.4 s (screenshot 0.3 s, upload 0.2 s, compare 0.9 s, 1 retake)');
  });
});
