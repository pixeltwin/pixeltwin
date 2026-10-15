// Builds standalone binaries: `bun scripts/build.ts` (this machine), `… linux-x64 darwin-arm64`, `… all`.
// Writes dist/pixeltwin-<version>-<target>[.exe] and dist/SHA256SUMS.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { VERSION } from '../src/version';

export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'] as const;
export type Target = (typeof TARGETS)[number];

function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

export function nativeTarget(platform: string = process.platform, arch: string = process.arch): Target {
  const target = `${platform === 'win32' ? 'windows' : platform}-${arch}`;
  if (!isTarget(target)) throw new Error(`No binary target for ${platform}-${arch}.`);
  return target;
}

export function parseTargets(args: string[]): Target[] {
  if (args.length === 0) return [nativeTarget()];
  if (args.includes('all')) return [...TARGETS];
  return args.map((arg) => {
    if (!isTarget(arg)) throw new Error(`Unknown target "${arg}". Use one of: ${TARGETS.join(', ')}, all.`);
    return arg;
  });
}

export function outfileFor(target: Target, version: string = VERSION): string {
  return `pixeltwin-${version}-${target}${target.startsWith('windows') ? '.exe' : ''}`;
}

/**
 * Bun's x64 default needs AVX2 (Haswell, 2013+); the baseline build runs on any x86-64 CPU,
 * including older servers and some VMs, at a small speed cost. File names stay the same.
 */
export function bunTarget(target: Target): string {
  return `bun-${target}${target.endsWith('-x64') ? '-baseline' : ''}`;
}

/** The worker is a second entrypoint: inside the binary it is loaded as ./diff/worker.ts. */
export function build(targets: Target[], outDir = 'dist'): string[] {
  mkdirSync(outDir, { recursive: true });
  const files = targets.map((target) => {
    const outfile = join(outDir, outfileFor(target));
    const args = [
      'build',
      '--compile',
      '--minify',
      `--target=${bunTarget(target)}`,
      'src/main.ts',
      'src/diff/worker.ts',
    ];
    const result = Bun.spawnSync([process.execPath, ...args, '--outfile', outfile], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (result.exitCode !== 0) throw new Error(`bun build failed for ${target}.`);
    return outfile;
  });
  const sums = files.map(
    (file) => `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${basename(file)}`,
  );
  writeFileSync(join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  return files;
}

if (import.meta.main) {
  for (const file of build(parseTargets(Bun.argv.slice(2)))) console.log(file);
}
