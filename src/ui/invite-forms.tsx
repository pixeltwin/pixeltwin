import type { InviteView } from '../domain/invites';
import { Pill, Until } from './components';
import type { Ui } from './context';

/** A new one-time link, shown once with Copy (like a new token). */
export function LinkCreated(props: { title: string; email: string; link: string; mailed: boolean; note: string }) {
  return (
    <div class="token-created" data-link-created>
      <h2>{props.title}</h2>
      <p class="sub">
        {props.mailed ? `We also mailed it to ${props.email}. ` : `Send it to ${props.email} yourself. `}
        {props.note}
      </p>
      <div class="token-row">
        <code id="new-link-value">{props.link}</code>
        <button type="button" class="primary small" data-copy-from="new-link-value" hidden>
          Copy
        </button>
      </div>
      <p class="warning">This is the only time the link is shown. Anyone with it can use it.</p>
    </div>
  );
}

/** Pending invites with Resend and Revoke; `base` is where their forms post (`…/invites`). */
export function PendingInvites({
  ui,
  invites,
  base,
  showProject,
}: {
  ui: Ui;
  invites: InviteView[];
  base: string;
  showProject: boolean;
}) {
  if (invites.length === 0) return null;
  return (
    <div class="pending-invites">
      <h3>Pending invites</h3>
      <table class="stack-on-phone">
        <thead>
          <tr>
            <th>Email</th>
            {showProject && <th>Project</th>}
            <th>Role</th>
            <th>Invited by</th>
            <th>Expires</th>
            <th>
              <span class="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invites.map((i) => (
            <tr>
              <td>{i.email}</td>
              {showProject && <td>{i.project ? i.project.name : <span class="muted">none</span>}</td>}
              <td>
                <span class="status">
                  {i.projectRole && <Pill tone="grey">{i.projectRole}</Pill>}
                  {i.role && i.role !== 'viewer' && <Pill tone="grey">{`server: ${i.role}`}</Pill>}
                  {!i.projectRole && !i.role && <Pill tone="grey">viewer</Pill>}
                </span>
              </td>
              <td>{i.invitedBy ?? <span class="muted">—</span>}</td>
              <td>
                <Until at={i.expiresAt} />
              </td>
              <td>
                <span class="row-actions">
                  <form method="post" action={ui.url(`${base}/${i.id}/resend`)}>
                    <button class="small" type="submit">
                      Resend
                    </button>
                  </form>
                  <form method="post" action={ui.url(`${base}/${i.id}/delete`)}>
                    <button
                      class="danger small"
                      type="submit"
                      data-confirm={`Revoke the invite of ${i.email}? Its link stops working.`}
                      data-confirm-label="Revoke"
                    >
                      Revoke
                    </button>
                  </form>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
