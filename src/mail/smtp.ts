import { type Socket, connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomToken } from '../domain/auth/random';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends one mail; rejects on any failure. The seam tests replace. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** A header value must not break out of its line (header injection). */
function headerSafe(value: string, name: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`mail ${name} contains a line break`);
  return value;
}

/** RFC 2047 for anything outside printable ASCII. */
function encodeWord(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

function base64Lines(value: string): string {
  return (
    Buffer.from(value)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? ''
  );
}

/** A multipart/alternative message (plain text and HTML), base64 bodies, CRLF line ends. */
export function formatMessage(from: string, mail: Mail, now = new Date()): string {
  const boundary = `pt-${randomToken()}`;
  const domain = /@([^>\s]+)>?$/.exec(from)?.[1] ?? 'pixeltwin';
  return [
    `From: ${headerSafe(from, 'from')}`,
    `To: ${headerSafe(mail.to, 'to')}`,
    `Subject: ${encodeWord(headerSafe(mail.subject, 'subject'))}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomToken()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Reads SMTP replies (possibly multi-line: `250-…` then `250 …`) from a socket. */
class Replies {
  #buffer = '';
  #lines: string[] = [];
  #waiting: Array<{ resolve: (reply: { code: number; text: string }) => void; reject: (err: Error) => void }> = [];
  #error: Error | null = null;

  attach(socket: Socket): void {
    socket.on('data', (chunk: Buffer | string) => {
      this.#buffer += chunk.toString();
      let at = this.#buffer.indexOf('\r\n');
      while (at >= 0) {
        const line = this.#buffer.slice(0, at);
        this.#buffer = this.#buffer.slice(at + 2);
        this.#lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const lines = this.#lines;
          this.#lines = [];
          this.#waiting.shift()?.resolve({ code: Number(line.slice(0, 3)), text: lines.join('\n') });
        }
        at = this.#buffer.indexOf('\r\n');
      }
    });
    const fail = (err: Error) => {
      this.#error = err;
      for (const w of this.#waiting.splice(0)) w.reject(err);
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('the SMTP server closed the connection')));
  }

  next(): Promise<{ code: number; text: string }> {
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
  }
}

/**
 * A minimal SMTP client: `smtps://` is TLS from the start; `smtp://` upgrades with STARTTLS when the
 * server offers it. Credentials are never sent over plain text, except to localhost.
 */
export function smtpMailer(options: { url: string; from: string; timeoutMs?: number }): Mailer {
  const url = new URL(options.url);
  const implicitTls = url.protocol === 'smtps:';
  const host = url.hostname;
  const port = Number(url.port || (implicitTls ? 465 : 587));
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  const sender = /<([^>]+)>/.exec(options.from)?.[1] ?? options.from;

  return {
    async send(mail) {
      const message = formatMessage(options.from, mail);
      let socket: Socket = implicitTls ? tlsConnect({ host, port, servername: host }) : tcpConnect({ host, port });
      const timer = setTimeout(
        () => socket.destroy(new Error('the SMTP server timed out')),
        options.timeoutMs ?? 15_000,
      );
      try {
        let replies = new Replies();
        replies.attach(socket);
        const expect = async (codes: number[], what: string) => {
          const reply = await replies.next();
          if (!codes.includes(reply.code)) throw new Error(`SMTP ${what}: ${reply.code} ${reply.text.slice(0, 200)}`);
          return reply;
        };
        const command = (line: string, codes: number[], what: string) => {
          socket.write(`${line}\r\n`);
          return expect(codes, what);
        };
        await expect([220], 'greeting');
        let hello = await command(`EHLO ${headerSafe(sender.split('@')[1] ?? 'pixeltwin', 'from')}`, [250], 'EHLO');
        let secure = implicitTls;
        if (!secure && /\bSTARTTLS\b/i.test(hello.text)) {
          await command('STARTTLS', [220], 'STARTTLS');
          socket.removeAllListeners('data');
          socket = tlsConnect({ socket, servername: host });
          replies = new Replies();
          replies.attach(socket);
          secure = true;
          hello = await command(`EHLO ${sender.split('@')[1] ?? 'pixeltwin'}`, [250], 'EHLO');
        }
        if (user) {
          if (!secure && !LOCAL_HOSTS.has(host)) throw new Error('refusing to send SMTP credentials without TLS');
          const plain = Buffer.from(`\0${user}\0${pass}`).toString('base64');
          await command(`AUTH PLAIN ${plain}`, [235], 'AUTH');
        }
        await command(`MAIL FROM:<${headerSafe(sender, 'from')}>`, [250], 'MAIL FROM');
        await command(`RCPT TO:<${headerSafe(mail.to, 'to')}>`, [250, 251], 'RCPT TO');
        await command('DATA', [354], 'DATA');
        // Dot-stuffing: a line starting with "." gets another one.
        socket.write(`${message.replace(/\r\n\./g, '\r\n..')}\r\n.\r\n`);
        await expect([250], 'message');
        socket.write('QUIT\r\n');
      } finally {
        clearTimeout(timer);
        socket.end();
      }
    },
  };
}

/**
 * Sends without making the caller wait or fail: a mail error is logged (never the mail, which
 * may hold a link) and the caller's answer stays the same. Resolves when done, for tests.
 */
export function deliver(
  mailer: Mailer | null | undefined,
  mail: Mail,
  log: (msg: string, fields: Record<string, unknown>) => void,
  what: string,
): Promise<void> {
  if (!mailer) return Promise.resolve();
  return mailer.send(mail).catch((err: unknown) => {
    log('mail not sent', { what, error: err instanceof Error ? err.message : String(err) });
  });
}
