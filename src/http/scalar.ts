// The Scalar API reference bundle, embedded as text so /docs works offline and in the compiled binary.
// The package does not export this file, hence the relative path into node_modules.
// @ts-expect-error -- a `type: 'text'` import of a .js file is a string at runtime; TypeScript cannot know that.
import bundle from '../../node_modules/@scalar/api-reference/dist/browser/standalone.js' with { type: 'text' };

export const SCALAR_BUNDLE: string = bundle;
