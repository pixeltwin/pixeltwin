import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { VERSION } from '../../src/version';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the Helm chart deploys the current version by default', () => {
  const appVersion = /^appVersion:\s*"?([^"\s]+)"?/m.exec(read('deploy/helm/pixeltwin/Chart.yaml'))?.[1];
  expect(appVersion).toBe(VERSION);
});

test('the Helm chart runs the image as its nonroot user on port 8080 with /data mounted', () => {
  const values = read('deploy/helm/pixeltwin/values.yaml');
  expect(values).toContain('runAsUser: 65532');
  expect(values).toContain('fsGroup: 65532');
  const deployment = read('deploy/helm/pixeltwin/templates/deployment.yaml');
  expect(deployment).toContain('containerPort: 8080');
  expect(deployment).toContain('mountPath: /data');
  expect(deployment).toContain('path: /healthz');
});

test('the Helm chart passes every server setting to the container', () => {
  const variables = [...read('src/config.ts').matchAll(/^ {2}([A-Z_]+): z/gm)].map((m) => m[1]);
  expect(variables.length).toBeGreaterThan(15);
  const deployment = read('deploy/helm/pixeltwin/templates/deployment.yaml');
  const missing = variables.filter((name) => !deployment.includes(`- name: ${name}\n`));
  expect(missing).toEqual([]);
});

test('the Helm chart values schema is valid JSON and requires publicUrl', () => {
  const schema = JSON.parse(read('deploy/helm/pixeltwin/values.schema.json')) as { required: string[] };
  expect(schema.required).toContain('publicUrl');
});
