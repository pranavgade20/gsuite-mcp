export type MimeMessage = {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
};

function headerList(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

export function buildRawMessage(msg: MimeMessage): string {
  const headers: string[] = [];
  if (msg.from) headers.push(`From: ${msg.from}`);
  headers.push(`To: ${headerList(msg.to)}`);
  if (msg.cc) headers.push(`Cc: ${headerList(msg.cc)}`);
  if (msg.bcc) headers.push(`Bcc: ${headerList(msg.bcc)}`);
  headers.push(`Subject: ${encodeHeader(msg.subject)}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: 7bit");
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${msg.inReplyTo}`);
  if (msg.references?.length) headers.push(`References: ${msg.references.join(" ")}`);

  const raw = `${headers.join("\r\n")}\r\n\r\n${msg.body}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for non-ASCII subjects.
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
