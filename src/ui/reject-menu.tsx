import type { Child } from 'hono/jsx';
import type { RejectReason } from '../db/schema';
import { REJECT_REASON_INFO, REJECT_REASON_LIST } from '../domain/reject-reasons';
import { field } from './context';

/**
 * Reject with a reason: a small popover anchored to the Reject button, a native <details> so it
 * opens without JavaScript too (the form posts the chosen category and the comment). With it, the
 * reject island opens it on R, picks a category with 1–7, rejects on Enter and closes on Esc;
 * Shift+R rejects at once without a reason.
 */
export function RejectMenu(props: {
  /** Where the form posts without JavaScript. */
  action: string;
  /** The Reject button's text. */
  label: string;
  title?: string | undefined;
  /** The `data-key` of the button: `r` where R opens it (the check page). */
  dataKey?: string | undefined;
  /** Opens upwards (the check page's action bar is at the bottom). */
  up?: boolean | undefined;
  /** A small button (a group card's actions). */
  small?: boolean | undefined;
  /** In-place attributes for the build page's live island (`data-inplace`, …). */
  formAttrs?: Record<string, string | undefined>;
  /** Hidden inputs. */
  children?: Child;
}) {
  return (
    <details class={props.up ? 'reject-menu up' : 'reject-menu'} data-reject-menu>
      <summary
        class={props.small ? 'button reject small' : 'button reject'}
        title={props.title}
        data-key={props.dataKey}
        data-key-label={props.dataKey ? 'Reject, with a reason (Shift+R: without)' : undefined}
      >
        {props.label}
        {props.dataKey && (
          <>
            {' '}
            <kbd>{props.dataKey.toUpperCase()}</kbd>
          </>
        )}
      </summary>
      <form class="reject-popover" method="post" action={props.action} data-reject-form {...(props.formAttrs ?? {})}>
        {props.children}
        <fieldset class="reason-chips" tabindex={-1} data-reason-chips>
          <legend>Why is it wrong?</legend>
          {REJECT_REASON_LIST.map((r, i) => (
            <label class="reason-chip" title={r.meaning}>
              <input type="radio" name="reasonCode" value={r.code} />
              <kbd>{String(i + 1)}</kbd>
              <span>{r.label}</span>
            </label>
          ))}
        </fieldset>
        <label class="reason-comment">
          <span class="muted">Comment (optional)</span>
          <input
            type="text"
            name="reason"
            maxlength={1000}
            autocomplete="off"
            placeholder="e.g. the banner had not loaded yet"
            data-reason-comment
          />
        </label>
        <div class="reject-actions">
          <button type="button" class="small ghost" data-reject-cancel>
            Cancel <kbd>Esc</kbd>
          </button>
          <button type="submit" class="small reject">
            Reject <kbd>↵</kbd>
          </button>
        </div>
      </form>
    </details>
  );
}

/** A rejection's category as a small tag, its meaning on hover. */
export function ReasonTag({ code }: { code: RejectReason | null | undefined }) {
  if (!code) return null;
  const info = REJECT_REASON_INFO[code];
  return (
    <span class={`reason-tag reason-${code}`} title={info.meaning}>
      {info.label}
    </span>
  );
}

/** The reason fields a review form posts: `reason` (or the older `comment`) and, rejecting, `reasonCode`. */
export function reasonInput(form: Record<string, unknown>, reject: boolean): Record<string, string> {
  const reason = field(form, 'reason') || field(form, 'comment');
  const reasonCode = reject ? field(form, 'reasonCode') : '';
  return { ...(reason ? { reason } : {}), ...(reasonCode ? { reasonCode } : {}) };
}
