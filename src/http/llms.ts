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
   Optional: "ignoreRegions":[{"x":0,"y":0,"width":1280,"height":64}], "colorThreshold" (0-1), "tolerancePercent",
   and "elements": the page's visible elements in the screenshot, at most 300, each
   {"key":"[data-testid=submit]","tag":"button","role":"button","name":"Send","text":"Send",
   "x":…,"y":…,"width":…,"height":…,"style":{"color":"#ffffff","background":"#0070f3","fontSize":"14px"}}
   (screenshot pixels; key: a test id, #id, role=…[name="…"] or a CSS path; "path": the CSS path).
   The Playwright and WebdriverIO SDKs send them by default.

3. Read the check: \`result\`, \`diff.summary\` (one sentence) and \`diff.regions\` (changed boxes:
   x, y, width, height, pixels). \`links.diff\` is a PNG with changes in red. When the check and
   its baseline both came with elements, \`diff.changes\` says what changed element by element,
   most important first (at most 50): {"kind":"moved"|"resized"|"text"|"style"|"added"|"removed",
   "key","role","from","to" (boxes; null when added/removed),"dx","dy","text":{"from","to"},
   "style":{"color":{"from","to"}},"regions":[indexes into diff.regions],"description"}, and the
   summary names them ("\`button[data-testid=submit]\` moved 4 px down; heading text changed from
   "Sign in" to "Log in". 1 other changed region. 1.20% of pixels changed."). Regions no element
   explains are counted in the summary. GET ${api}/checks/<checkId>/elements returns both sides'
   elements.

   curl ${api}/checks/<checkId> -H "Authorization: Bearer $PIXELTWIN_TOKEN"

   A busy server answers 503 server_busy with Retry-After: wait that many seconds and post
   the same screenshot again. Keep 4-8 uploads in flight per run rather than all at once.

4. Finalize the build when every screenshot is posted.

   curl -X POST ${api}/builds/<buildId>/finalize -H "Authorization: Bearer $PIXELTWIN_TOKEN"

5. Act on \`verdict\`. Only \`passed\` is success. Changes wait for a human (or a token with the
   \`review\` scope): POST ${api}/checks/<checkId>/approve or /reject with {"reason":"…"} (kept in
   the review history, GET ${api}/checks/<checkId>/reviews, with actorKind user | token | auto).
   /reset undoes either. The answer's \`outcome\` is \`applied\` or \`suggested\` (see Agent reviews).
   A screen part that always changes (a clock, an ad) can be skipped for good: POST
   ${api}/checks/<checkId>/areas {"kind":"ignore","x":…,"y":…,"width":…,"height":…} applies
   to every later check of that snapshot; kind "compare" compares only inside such areas.
   A snapshot has one kind of area (409 area_kind_conflict otherwise). PATCH
   ${api}/checks/<checkId>/areas/<areaId> {"x":…,"y":…,"width":…,"height":…} moves one.

6. After merging a branch, promote it so main does not ask to review the same screens again:
   GET ${api}/projects/<slug>/branches/<branch>/promote lists the screens that differ from main;
   POST the same URL (optionally {"snapshotKeys":[…]} to pick some) copies their baselines to
   main. URL-encode the branch (feature%2Flogin). Needs the write scope. A project whose GitHub
   or GitLab integration has "promote on merge" does this by itself when the pull request merges.

## Pull requests

Send "commitSha", "repository" (owner/name; GitLab: group/sub/project) and "pullRequest" (the
number; GitLab: the merge request IID) when opening a build, and a project with a GitHub or GitLab
integration posts the commit status pixeltwin/<slug> (pending while screenshots wait for review,
success when passed, failure when rejected or an error) and one comment per build on the pull
request. Approving updates them, so CI need not run again. Admins set it up with
PATCH ${api}/projects/<slug>/integration and add webhooks (build.finalized,
build.verdict_changed, check.reviewed; signed X-Pixeltwin-Signature: sha256=<HMAC>) with
POST ${api}/projects/<slug>/webhooks.

## Agent reviews (an agent that changed the UI)

1. After the test run: GET ${api}/projects/<slug>/builds?branch=<your branch>&limit=1, then
   GET ${api}/builds/<buildId>/checks?result=changed (and result=new).
2. For each check read \`diff.changes\` (and \`diff.summary\`); look at the images (\`links\`) when
   unsure. Decide: is every change one you meant to make?
3. Intended: POST /checks/<id>/approve {"reason":"Moved the submit button below the form, as asked"}.
   Not intended: POST /checks/<id>/reject {"reason":"…"} and fix the code. Never approve what you
   did not intend; leave it for a person instead.

A project's \`agentReview\` policy decides what a token's review does: \`off\` (it applies),
\`suggest\` (it is recorded as \`check.suggestion\`; the check stays pending until a person accepts
or dismisses it: POST /checks/<id>/suggestion/accept or /suggestion/dismiss) or \`auto-below\`
(approvals of a diff up to \`agentMaxDiffPercent\` apply; larger ones and new screenshots become
suggestions; rejections apply). Unless \`off\`, a token must give a reason (422 reason_required)
and cannot change areas (403 agent_review_policy). \`build.counts.suggested\` counts open suggestions.
A suggestion leaves the commit status pending and sends no check.reviewed webhook; a person
accepting it does both, with the agent's reason.

MCP: \`npx pixeltwin mcp\` (package @pixeltwin/client) is a Model Context Protocol server on stdio
with these steps as tools: latest_build, list_changes, get_check, get_check_images (cropped to a
change), approve_check, reject_check (with a reason) and add_ignore_area. Environment:
PIXELTWIN_URL=${publicUrl}, PIXELTWIN_TOKEN (read and review), PIXELTWIN_PROJECT.

## Values

check.result:  unchanged | changed | new (no baseline yet) | error (diff failed; see diff.error)
check.review:  none (nothing to review) | pending | approved | rejected | outdated (a newer build
               of the branch approved this screen; it cannot be approved or rejected: 409 check_outdated)
build.verdict: empty (no checks) | error | rejected | pending | outdated | passed
review event:  approved | rejected | reset | suggested_approval | suggested_rejection | suggestion_dismissed

## Errors

Errors are application/problem+json with a stable \`code\` (e.g. build_finalized, invalid_image,
validation_failed with \`errors[].path\`, reason_required, agent_review_policy, no_suggestion).
Branch on \`code\`, not on \`detail\`.
`;
}
