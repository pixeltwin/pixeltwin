import type { OpenAPIHono } from '@hono/zod-openapi';
import { VERSION } from '../version';
import type { AppEnv, Services } from './env';
import { llmsTxt } from './llms';
import { SCALAR_BUNDLE } from './scalar';

export function openApiDocument(app: OpenAPIHono<AppEnv>) {
  return app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'pixeltwin',
      version: VERSION,
      description:
        'Self-hosted visual regression testing. Each operation lists its required permission in `x-permission`. Agents: start with /llms.txt.',
    },
  });
}

// Relative URLs keep /docs working when pixeltwin is served under a path prefix.
const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pixeltwin API</title>
</head>
<body>
<script id="api-reference" data-url="openapi.json" data-configuration='{"withDefaultFonts":false}'></script>
<script src="docs/scalar.js"></script>
</body>
</html>
`;

const DOCS_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

/** Public, outside /api/v1: /openapi.json, /docs, /docs/scalar.js, /llms.txt. */
export function registerDocRoutes(app: OpenAPIHono<AppEnv>, s: Services): void {
  let document: ReturnType<typeof openApiDocument> | undefined;
  app.get('/openapi.json', (c) => {
    document ??= openApiDocument(app);
    return c.json(document);
  });
  app.get('/docs', (c) =>
    c.html(DOCS_HTML, 200, { 'content-security-policy': DOCS_CSP, 'referrer-policy': 'same-origin' }),
  );
  app.get('/docs/scalar.js', (c) =>
    c.body(SCALAR_BUNDLE, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=86400',
    }),
  );
  app.get('/llms.txt', (c) => c.text(llmsTxt(s.config.publicUrl)));
}
