import type { gmail_v1 } from "googleapis";

export type ReplyContext = {
  threadId: string;
  inReplyTo: string;
  references: string[];
  subject: string;
  to: string;
  cc?: string;
};

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === lower)?.value ?? undefined;
}

export function deriveReplyContext(message: gmail_v1.Schema$Message): ReplyContext {
  const headers = message.payload?.headers;
  const messageId = headerValue(headers, "Message-ID") ?? "";
  const existingReferences = headerValue(headers, "References");
  const subject = headerValue(headers, "Subject") ?? "";
  const fromHeader = headerValue(headers, "From") ?? "";
  const replyTo = headerValue(headers, "Reply-To") ?? fromHeader;
  const cc = headerValue(headers, "Cc");

  const refs: string[] = [];
  if (existingReferences) refs.push(...existingReferences.split(/\s+/).filter(Boolean));
  if (messageId && !refs.includes(messageId)) refs.push(messageId);

  return {
    threadId: message.threadId ?? "",
    inReplyTo: messageId,
    references: refs,
    subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
    to: replyTo,
    cc,
  };
}
