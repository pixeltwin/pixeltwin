import type { Mail } from './smtp';

// The mails pixeltwin sends: plain text first, and the same in simple HTML.

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function mail(to: string, subject: string, lines: string[], link?: { url: string; label: string }): Mail {
  const text = [...lines, ...(link ? ['', `${link.label}: ${link.url}`] : []), '', '— pixeltwin'].join('\n');
  const paragraphs = lines.filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`);
  const button = link
    ? `<p><a href="${escapeHtml(link.url)}" style="display:inline-block;padding:8px 14px;background:#111;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(link.label)}</a></p><p style="color:#666;font-size:13px">${escapeHtml(link.url)}</p>`
    : '';
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:15px;color:#111">${paragraphs.join('')}${button}<p style="color:#666">— pixeltwin</p></body></html>`;
  return { to, subject, text, html };
}

export function inviteMail(to: string, url: string, invitedBy: string | null, projects: string[]): Mail {
  const where = projects.length > 0 ? ` to ${projects.join(', ')}` : '';
  return mail(
    to,
    'You are invited to pixeltwin',
    [
      `${invitedBy ?? 'An admin'} invited you${where} on pixeltwin, where screenshots of the app are reviewed.`,
      'Open the link to choose a password. It works once, for 7 days.',
    ],
    { url, label: 'Accept the invite' },
  );
}

export function resetMail(to: string, url: string): Mail {
  return mail(
    to,
    'Set a new pixeltwin password',
    ['Open the link to choose a new password. It works once, for an hour.', 'Did not ask for it? Ignore this mail.'],
    { url, label: 'Set a new password' },
  );
}

export function verifyMail(to: string, url: string): Mail {
  return mail(
    to,
    'Confirm your email for pixeltwin',
    [
      'You asked for access to pixeltwin. Confirm that this is your email; an admin then looks at your request.',
      'Did not ask for it? Ignore this mail.',
    ],
    { url, label: 'Confirm my email' },
  );
}

export function existingAccountMail(to: string, loginUrl: string): Mail {
  return mail(
    to,
    'You already have a pixeltwin account',
    [
      'Someone asked for access to pixeltwin with this email, but it already has an account.',
      'Log in instead; if you forgot the password, ask an admin for a reset link.',
    ],
    { url: loginUrl, label: 'Log in' },
  );
}

export function decisionMail(to: string, approved: boolean, loginUrl: string, reason: string | null): Mail {
  return approved
    ? mail(to, 'Your pixeltwin access was approved', ['An admin approved your request. You can log in now.'], {
        url: loginUrl,
        label: 'Log in',
      })
    : mail(to, 'Your pixeltwin access request', [
        'An admin turned down your request for access.',
        ...(reason ? [`Reason: ${reason}`] : []),
      ]);
}

export function newRequestsMail(to: string, count: number, url: string): Mail {
  return mail(
    to,
    count === 1 ? 'Someone asks for access to pixeltwin' : `${count} people ask for access to pixeltwin`,
    [`${count === 1 ? 'A new access request waits' : `${count} access requests wait`} for an admin.`],
    { url, label: 'Review access requests' },
  );
}
