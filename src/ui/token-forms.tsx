import { TOKEN_SCOPES } from '../domain/auth/tokens';
import { describedBy, Field, Pill } from './components';
import type { Ui } from './context';

const SCOPE_HELP: Record<(typeof TOKEN_SCOPES)[number], string> = {
  read: 'see builds, checks and images',
  write: 'open builds and post screenshots',
  review: 'approve and reject checks',
};

/** Creates a token. With JavaScript the tokens island posts it to the API and shows the result in the dialog. */
export function NewTokenForm({
  ui,
  slug,
  values = {},
  errors = {},
  inDialog,
}: {
  ui: Ui;
  slug: string;
  values?: { name?: string | undefined; scopes?: string[] };
  errors?: Record<string, string>;
  inDialog: boolean;
}) {
  const scopes = values.scopes ?? ['read', 'write'];
  return (
    <form method="post" action={ui.url(`/ui/p/${slug}/settings/tokens`)} data-token-form data-slug={slug}>
      {errors._form && <p class="flash error">{errors._form}</p>}
      <Field id="token-name" label="Name" hint="Where it is used, e.g. GitHub Actions." error={errors.name}>
        <input
          name="name"
          type="text"
          required
          autocomplete="off"
          value={values.name ?? ''}
          {...describedBy('token-name', 'hint', errors.name)}
        />
      </Field>
      <fieldset>
        <legend>Scopes</legend>
        {TOKEN_SCOPES.map((scope) => (
          <label class="scope">
            <input type="checkbox" name="scopes" value={scope} checked={scopes.includes(scope)} />
            <span>
              <strong>{scope}</strong> <span class="muted">{SCOPE_HELP[scope]}</span>
            </span>
          </label>
        ))}
        {errors.scopes && <p class="field-error">{errors.scopes}</p>}
      </fieldset>
      <div class="dialog-actions">
        {inDialog ? (
          <button type="button" data-dialog-close>
            Cancel
          </button>
        ) : (
          <a class="button" href={ui.url(`/ui/p/${slug}/settings`)}>
            Cancel
          </a>
        )}
        <button class="primary" type="submit">
          Create token
        </button>
      </div>
    </form>
  );
}

/** The new token, shown once (UI spec §4.2). The tokens island builds the same markup after an API call. */
export function TokenCreated({ name, scopes, token }: { name: string; scopes: string[]; token: string }) {
  return (
    <div class="token-created">
      <h2>{`Token “${name}” created`}</h2>
      <p class="status">
        {scopes.map((scope) => (
          <Pill tone="grey">{scope}</Pill>
        ))}
      </p>
      <div class="token-row">
        <code id="new-token-value">{token}</code>
        <button type="button" class="primary small" data-copy-from="new-token-value" hidden>
          Copy
        </button>
      </div>
      <p class="warning">This is the only time the full token is shown. Store it in your CI secrets now.</p>
      <pre class="command">
        <code>{`export PIXELTWIN_TOKEN=${token}`}</code>
      </pre>
    </div>
  );
}

export function NewTokenButton({ ui, slug, label = 'New token' }: { ui: Ui; slug: string; label?: string }) {
  return (
    <a class="button primary" href={ui.url(`/ui/p/${slug}/settings/tokens/new`)} data-dialog-open="new-token">
      {label}
    </a>
  );
}

export function NewTokenDialog({ ui, slug }: { ui: Ui; slug: string }) {
  return (
    <dialog id="new-token" aria-labelledby="new-token-title">
      <h2 id="new-token-title">New token</h2>
      <NewTokenForm ui={ui} slug={slug} inDialog />
    </dialog>
  );
}
