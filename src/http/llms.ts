/** Spec §10: plain-text instructions for agents. */
export function llmsTxt(publicUrl: string): string {
  const api = `${publicUrl}/api/v1`;
  return `# pixeltwin

> Self-hosted visual regression testing. Post screenshots; pixeltwin compares them with approved
> baselines and answers with a verdict plus a machine-readable diff.

Full API: ${publicUrl}/openapi.json (OpenAPI 3.1; each operation's \`x-permission\` says what it needs).
Human-readable reference: ${publicUrl}/docs

## Authentication

Send a project token: \`Authorization: Bearer pt_…\`. An admin creates tokens with scopes
\`read\`, \`write\` (builds and checks) and \`review\` (approve/reject). A token only sees its own project.

## Workflow (five calls)

1. Open a build. Reuse \`externalId\` on retries; the same build comes back. Its \`number\`
   counts builds per project (#1, #2, …), as the web UI shows them.

   curl -X POST ${api}/projects/<slug>/builds \\
     -H "Authorization: Bearer $PIXELTWIN_TOKEN" -H "Content-Type: application/json" \\
     -d '{"branch":"feature/login","baseBranch":"main","externalId":"ci-run-123"}'

2. Post each screenshot. The response arrives after the comparison.

   curl -X POST ${api}/builds/<buildId>/checks \\
     -H "Authorization: Bearer $PIXELTWIN_TOKEN" \\
     -F image=@login.png -F 'meta={"name":"login","variant":{"browser":"chromium","viewport":"1280x720"}}'

   Or JSON: {"name":"login","variant":{…},"imageBase64":"<base64 PNG>"}.
   Optional: "ignoreRegions":[{"x":0,"y":0,"width":1280,"height":64}], "colorThreshold" (0-1), "tolerancePercent".

3. Read the check: \`result\`, \`diff.summary\` (one sentence) and \`diff.regions\` (changed boxes:
   x, y, width, height, pixels). \`links.diff\` is a PNG with changes in red.

   curl ${api}/checks/<checkId> -H "Authorization: Bearer $PIXELTWIN_TOKEN"

4. Finalize the build when every screenshot is posted.

   curl -X POST ${api}/builds/<buildId>/finalize -H "Authorization: Bearer $PIXELTWIN_TOKEN"

5. Act on \`verdict\`. Only \`passed\` is success. Changes wait for a human (or a token with the
   \`review\` scope): POST ${api}/checks/<checkId>/approve or /reject. /reset undoes either.

## Values

check.result:  unchanged | changed | new (no baseline yet) | error (diff failed; see diff.error)
check.review:  none (nothing to review) | pending | approved | rejected
build.verdict: empty (no checks) | error | rejected | pending | passed

## Errors

Errors are application/problem+json with a stable \`code\` (e.g. build_finalized, invalid_image,
validation_failed with \`errors[].path\`). Branch on \`code\`, not on \`detail\`.
`;
}
