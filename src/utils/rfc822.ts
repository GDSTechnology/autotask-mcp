// Minimal, dependency-free RFC 822 / MIME reader for the "Originating Email"
// attachment Autotask's email processor stores on email-created tickets
// (contentType message/rfc822). Enough to audit where a ticket came from:
// headers (unfolded, RFC 2047-decoded), parsed addresses, the plain-text body
// (or text from HTML), and the list of attached parts. Never throws on a
// malformed message — it returns what it could read.

export interface MailAddress { name: string | null; address: string | null }

export interface ParsedMail {
  headers: Array<{ name: string; value: string }>;
  header(name: string): string | undefined;
  all(name: string): string[];
  textBody: string | null;
  /** 'text/plain', 'text/html' (converted), or null when no text part. */
  textSource: 'text/plain' | 'text/html' | null;
  parts: Array<{ contentType: string; filename: string | null; size: number }>;
}

const decoder = (charset: string | undefined): TextDecoder => {
  try { return new TextDecoder((charset || 'utf-8').trim().toLowerCase()); } catch { return new TextDecoder('utf-8'); }
};

/** Decode RFC 2047 encoded-words: =?charset?B|Q?text?= (adjacent words join without the space). */
export function decodeEncodedWords(s: string): string {
  return s
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?[^?]+\?[bBqQ]\?[^?]*\?=)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
      try {
        const bytes = enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
        return decoder(cs.split('*')[0]).decode(bytes);
      } catch { return text; }
    });
}

/** Split a header block into unfolded {name, value} pairs (values RFC 2047-decoded). */
export function parseHeaderBlock(block: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) { out[out.length - 1]!.value += ' ' + line.trim(); continue; }
    const i = line.indexOf(':');
    if (i > 0) out.push({ name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  return out.map((h) => ({ name: h.name, value: decodeEncodedWords(h.value) }));
}

/** "Jane Doe" <jane@x.com> | jane@x.com | Jane <jane@x.com> → {name, address}. */
export function parseAddress(s: string | undefined): MailAddress {
  if (!s) return { name: null, address: null };
  const t = s.trim();
  const angle = t.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  if (angle) {
    const name = angle[1]!.trim().replace(/^"(.*)"$/, '$1').trim();
    return { name: name || null, address: angle[2]!.toLowerCase() };
  }
  const bare = t.match(/([^\s<>"]+@[^\s<>"]+)/);
  return { name: null, address: bare ? bare[1]!.toLowerCase() : null };
}

/** Comma-separated address list (commas inside quotes or angle brackets ignored). */
export function parseAddressList(s: string | undefined): MailAddress[] {
  if (!s) return [];
  const parts: string[] = [];
  let cur = '', quoted = false, angle = 0;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') angle++;
    if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && !quoted && angle === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(parseAddress).filter((a) => a.address);
}

/** A header's main value and its ;-parameters (e.g. Content-Type boundary/charset). */
function headerParams(v: string | undefined): { value: string; params: Record<string, string> } {
  if (!v) return { value: '', params: {} };
  const [main, ...rest] = v.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const i = p.indexOf('=');
    if (i > 0) params[p.slice(0, i).trim().toLowerCase().replace(/\*$/, '')] = p.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { value: (main ?? '').trim().toLowerCase(), params };
}

function decodeTransfer(body: string, encoding: string | undefined): Buffer {
  const enc = (encoding || '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') {
    const s = body.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(s.charCodeAt(i) & 0xff);
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(body, 'latin1');
}

/** Plain text from HTML: drop style/script, turn breaks/blocks into newlines, strip tags, decode common entities. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function splitHeadBody(s: string): { head: string; body: string } {
  const m = s.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return { head: s, body: '' };
  return { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) };
}

interface Leaf { contentType: string; charset?: string; filename: string | null; disposition: string; data: Buffer }

function walk(entity: string, depth: number, leaves: Leaf[]): void {
  const { head, body } = splitHeadBody(entity);
  const hs = parseHeaderBlock(head);
  const get = (n: string) => hs.find((h) => h.name.toLowerCase() === n)?.value;
  const ct = headerParams(get('content-type') || 'text/plain');
  const cd = headerParams(get('content-disposition'));
  if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 8) {
    const b = ct.params.boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const chunks = body.split(new RegExp(`\\r?\\n?--${b}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    for (const c of chunks.slice(1)) if (c.trim()) walk(c, depth + 1, leaves);
    return;
  }
  leaves.push({
    contentType: ct.value || 'text/plain',
    ...(ct.params.charset ? { charset: ct.params.charset } : {}),
    filename: cd.params.filename ?? ct.params.name ?? null,
    disposition: cd.value,
    data: decodeTransfer(body, get('content-transfer-encoding')),
  });
}

/** Parse a raw RFC 822 message (Buffer or latin1/utf-8 string). */
export function parseRfc822(raw: Buffer | string): ParsedMail {
  // latin1 keeps every byte 1:1, so 8-bit parts decode correctly with their own charset later.
  const s = Buffer.isBuffer(raw) ? raw.toString('latin1') : raw;
  const { head } = splitHeadBody(s);
  const headers = parseHeaderBlock(head);
  const leaves: Leaf[] = [];
  try { walk(s, 0, leaves); } catch { /* keep the headers */ }
  const isAttachment = (l: Leaf) => l.disposition === 'attachment' || (l.filename != null && !l.contentType.startsWith('text/'));
  const plain = leaves.find((l) => l.contentType === 'text/plain' && !isAttachment(l));
  const html = leaves.find((l) => l.contentType === 'text/html' && !isAttachment(l));
  let textBody: string | null = null;
  let textSource: ParsedMail['textSource'] = null;
  if (plain) { textBody = decoder(plain.charset).decode(plain.data).trim(); textSource = 'text/plain'; }
  else if (html) { textBody = htmlToText(decoder(html.charset).decode(html.data)); textSource = 'text/html'; }
  return {
    headers,
    header: (n) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value,
    all: (n) => headers.filter((h) => h.name.toLowerCase() === n.toLowerCase()).map((h) => h.value),
    textBody,
    textSource,
    parts: leaves.map((l) => ({ contentType: l.contentType, filename: l.filename ? decodeEncodedWords(l.filename) : null, size: l.data.length })),
  };
}
