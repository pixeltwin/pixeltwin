// Builds the SDK packages to packages/*/dist (ESM + declarations).
//   bun scripts/build-sdk.ts                 build
//   bun scripts/build-sdk.ts pack <dir>      build, then `npm pack` each package into <dir> (never publishes)
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const packages = ['client', 'playwright', 'wdio']; // client first: the others compile against its dist

function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})`);
  return result.stdout;
}

for (const name of packages) {
  const dir = join(root, 'packages', name);
  rmSync(join(dir, 'dist'), { recursive: true, force: true });
  run(join(root, 'node_modules/.bin/tsc'), ['-p', join(dir, 'tsconfig.build.json')]);
  console.log(`built packages/${name}/dist`);
}
chmodSync(join(root, 'packages/client/dist/bin.js'), 0o755);

if (process.argv[2] === 'pack') {
  const out = resolve(process.argv[3] ?? 'dist/sdk');
  mkdirSync(out, { recursive: true });
  for (const name of packages) {
    const file = run('npm', ['pack', '--silent', '--pack-destination', out], join(root, 'packages', name)).trim();
    console.log(join(out, file));
  }
}
