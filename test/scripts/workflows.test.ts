import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

interface Step {
  run?: string;
  with?: Record<string, string>;
}
interface Job {
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  needs?: string;
  steps?: Step[];
}
interface Workflow {
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

function workflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(`.github/workflows/${name}`, 'utf8')) as Workflow;
}

describe.each(['ci.yml', 'release.yml'])('%s', (name) => {
  test('every job has a timeout, so a hung step cannot hold a runner for six hours', () => {
    const jobs = Object.entries(workflow(name).jobs);
    expect(jobs.length).toBeGreaterThan(0);
    for (const [id, job] of jobs) {
      expect({ id, timeout: job['timeout-minutes'] }).toEqual({ id, timeout: expect.any(Number) });
    }
  });
});

describe('release.yml permissions', () => {
  const release = workflow('release.yml');

  test('the workflow default is read-only', () => {
    expect(release.permissions).toEqual({ contents: 'read' });
  });

  test('each job gets only the write access it uses', () => {
    expect(release.jobs.binaries?.permissions).toEqual({ contents: 'write' });
    expect(release.jobs.image?.permissions).toEqual({ contents: 'read', packages: 'write' });
  });

  test('npm publishing only reads the repository and signs provenance', () => {
    expect(release.jobs.npm?.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });
});

describe('release.yml SDK', () => {
  const release = workflow('release.yml');
  const runs = (job: string) => (release.jobs[job]?.steps ?? []).map((s) => s.run ?? '').join('\n');

  test('the GitHub release carries the SDK tarballs, so they install without npm', () => {
    expect(runs('binaries')).toContain('bun scripts/build-sdk.ts pack dist/sdk');
    const upload = release.jobs.binaries?.steps?.find((s) => s.with?.files)?.with?.files ?? '';
    expect(upload).toContain('dist/sdk/*.tgz');
  });

  test('npm gets the packages after the release, the client first', () => {
    expect(release.jobs.npm?.needs).toBe('binaries');
    const script = runs('npm');
    const order = ['client', 'playwright', 'wdio'].map((name) => script.indexOf(`packages/${name}`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(script).toContain('npm publish --provenance --access public');
  });
});
