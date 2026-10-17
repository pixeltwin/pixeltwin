import { type ApiOptions, apiRequest, type CodeHost, upsertByMarker } from './http';

// GitHub adapter: commit statuses and pull request (issue) comments over the REST API.

export const GITHUB_API_URL = 'https://api.github.com';

export interface GitHubAuth {
  /** `https://api.github.com`, or a GitHub Enterprise Server's `https://host/api/v3`. */
  apiUrl: string;
  /** A fine-grained token (Commit statuses and Pull requests: write) or an installation token. */
  token: string;
}

function repoPath(repository: string): string {
  const [owner = '', name = ''] = repository.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function githubHost(auth: GitHubAuth, options: ApiOptions = {}): CodeHost {
  const target = {
    host: 'GitHub',
    base: auth.apiUrl.replace(/\/+$/, ''),
    token: auth.token,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${auth.token}`,
      'x-github-api-version': '2022-11-28',
    },
  };
  const call = <T>(method: string, path: string, body?: unknown) => apiRequest<T>(target, method, path, body, options);
  return {
    name: 'GitHub',
    async postStatus(repository, sha, status) {
      await call('POST', `${repoPath(repository)}/statuses/${encodeURIComponent(sha)}`, {
        state: status.state,
        description: status.description,
        context: status.context,
        target_url: status.targetUrl,
      });
    },
    upsertComment(repository, number, marker, body, knownId) {
      const repo = repoPath(repository);
      return upsertByMarker({
        knownId,
        marker,
        edit: (id) => call('PATCH', `${repo}/issues/comments/${encodeURIComponent(id)}`, { body }),
        page: async (n) =>
          (
            await call<Array<{ id: number; body?: string }>>(
              'GET',
              `${repo}/issues/${number}/comments?per_page=100&page=${n}`,
            )
          ).data,
        create: async () =>
          String((await call<{ id: number }>('POST', `${repo}/issues/${number}/comments`, { body })).data.id),
      });
    },
  };
}
