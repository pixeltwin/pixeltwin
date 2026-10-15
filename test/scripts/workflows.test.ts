import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

interface Job {
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
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
});
