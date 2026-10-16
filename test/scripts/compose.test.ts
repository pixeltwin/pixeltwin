import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the README shows the Postgres compose file exactly as it is in deploy/', () => {
  expect(read('README.md')).toContain(read('deploy/docker-compose.postgres.yml').trimEnd());
});

test('the Postgres compose file keeps screenshots in the database and needs a password', () => {
  const compose = Bun.YAML.parse(read('deploy/docker-compose.postgres.yml')) as {
    services: { pixeltwin: { environment: Record<string, string> } };
  };
  const env = compose.services.pixeltwin.environment;
  expect(env.STORAGE).toBe('postgres');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose's interpolation, not a template literal
  expect(env.DATABASE_URL).toBe('postgres://pixeltwin:${POSTGRES_PASSWORD}@db:5432/pixeltwin');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose's interpolation, not a template literal
  expect(read('deploy/docker-compose.postgres.yml')).toContain('${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}');
});
