import { createServer, type Server, type Socket } from 'node:net';

export interface Received {
  from: string;
  to: string[];
  auth: string | null;
  data: string;
}

/** The text of one MIME part (base64-decoded): `text/plain` or `text/html`. */
export function partOf(data: string, type: 'text/plain' | 'text/html'): string {
  const at = data.indexOf(`Content-Type: ${type}`);
  if (at < 0) return '';
  const body = data.slice(data.indexOf('\r\n\r\n', at) + 4);
  return Buffer.from(body.slice(0, body.indexOf('\r\n--')).replace(/\r\n/g, ''), 'base64').toString();
}

/**
 * A fake SMTP server on 127.0.0.1 (plain text, no TLS): accepts every mail and keeps it.
 * `failWith` makes it refuse each message with that reply.
 */
export async function fakeSmtp(options: { failWith?: string } = {}): Promise<{
  url: string;
  mails: Received[];
  close(): Promise<void>;
}> {
  const mails: Received[] = [];
  const server: Server = createServer((socket: Socket) => {
    let buffer = '';
    let current: Received = { from: '', to: [], auth: null, data: '' };
    let inData = false;
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('220 fake ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end).replace(/\r\n\.\./g, '\r\n.');
          buffer = buffer.slice(end + 5);
          inData = false;
          if (options.failWith) say(options.failWith);
          else {
            mails.push(current);
            say('250 queued');
          }
          current = { from: '', to: [], auth: null, data: '' };
          continue;
        }
        const at = buffer.indexOf('\r\n');
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') say('250-fake\r\n250 AUTH PLAIN');
        else if (verb === 'AUTH') {
          current.auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString();
          say('235 ok');
        } else if (verb === 'MAIL') {
          current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          say('250 ok');
        } else if (verb === 'RCPT') {
          current.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          say('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          say('354 go on');
        } else if (verb === 'QUIT') {
          say('221 bye');
          socket.end();
        } else say('250 ok');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `smtp://pixel:secret@127.0.0.1:${port}`,
    mails,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Waits until `count` mails arrived (background sends). */
export async function waitForMails(mails: Received[], count: number, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (mails.length < count) {
    if (Date.now() > until) throw new Error(`expected ${count} mails, got ${mails.length}`);
    await Bun.sleep(10);
  }
}
