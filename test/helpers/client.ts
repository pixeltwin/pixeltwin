import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_MODULES } from '../../src/ui/client-assets';

const dir = mkdtempSync(join(tmpdir(), 'pixeltwin-client-'));

/**
 * Imports a served client module exactly as the browser receives it. Bun caches modules by path
 * whatever the import attributes, so once the server has imported `src/ui/client/x.ts` as text,
 * a normal `import` of that file in a test would get the text. The transpiled code is written
 * to a temporary file instead. Pure modules have no imports, which is what lets them load alone.
 */
export async function clientModule<T>(name: string): Promise<T> {
  const code = CLIENT_MODULES[name];
  if (code === undefined) throw new Error(`no client module "${name}"`);
  if (new Bun.Transpiler({ loader: 'js' }).scanImports(code).length > 0) {
    throw new Error(`client module "${name}" has imports; only pure modules can be tested this way`);
  }
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, code);
  return (await import(file)) as T;
}
