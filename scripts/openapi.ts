// Regenerates openapi.json (committed; the contract test fails when it is stale).
import { buildOpenApiDocument } from '../src/http/doc-app';

await Bun.write('openapi.json', `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log('wrote openapi.json');
