import { CLIENT_MODULES } from '../../src/ui/client-assets';

/**
 * Imports a served client module exactly as the browser receives it. Bun caches modules by path
 * whatever the import attributes, so once the server has imported `src/ui/client/x.ts` as text,
 * a normal `import` of that file in a test would get the text. Pure modules have no imports,
 * which is what lets them load from a data: URL.
 */
export async function clientModule<T>(name: string): Promise<T> {
  const code = CLIENT_MODULES[name];
  if (code === undefined) throw new Error(`no client module "${name}"`);
  if (new Bun.Transpiler({ loader: 'js' }).scanImports(code).length > 0) {
    throw new Error(`client module "${name}" has imports; only pure modules can be tested this way`);
  }
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as T;
}
