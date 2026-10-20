import { google, gmail_v1 } from "googleapis";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { accountEmailSchema, accountFor } from "./common.js";

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function decodeBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }
  if (part.parts) {
    const text = part.parts.find((p) => p.mimeType === "text/plain");
    if (text) return decodeBody(text);
    const html = part.parts.find((p) => p.mimeType === "text/html");
    if (html) return decodeBody(html);
  }
  return "";
}

function pickHeaders(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  names: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const h of headers) {
    if (h.name && wanted.has(h.name.toLowerCase()) && h.value) {
      out[h.name] = h.value;
    }
  }
  return out;
}

async function pMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

function hasAttachment(part: gmail_v1.Schema$MessagePart | undefined): boolean {
  if (!part) return false;
  if (part.body?.attachmentId && part.filename) return true;
  if (part.parts) return part.parts.some(hasAttachment);
  return false;
}

function summarizeMessage(m: gmail_v1.Schema$Message) {
  const headers = pickHeaders(m.payload?.headers, [
    "From",
    "To",
    "Cc",
    "Subject",
    "Date",
    "Message-ID",
  ]);
  return {
    id: m.id,
    threadId: m.threadId,
    snippet: m.snippet,
    labelIds: m.labelIds,
    headers,
    body: decodeBody(m.payload ?? undefined),
  };
}

export function registerGmailReadTools(server: McpServer, enableWrite = false): void {
  server.tool(
    "gmail_search",
    "Search Gmail. Returns enriched metadata per match (from/subject/date/snippet/labelIds/hasAttachments) by default. Set format='ids' for the lighter ID-only response (cheaper, useful for piping to bulk ops).",
    {
      email: accountEmailSchema,
      query: z.string().describe("Gmail search query"),
      max_results: z.number().int().min(1).max(100).optional().describe("Default 20"),
      page_token: z.string().optional().describe("Pagination cursor from a previous call"),
      format: z
        .enum(["ids", "metadata"])
        .optional()
        .describe("Default 'metadata'. Use 'ids' to skip per-message header fetches."),
    },
    async ({ email, query, max_results, page_token, format }) => {
      const gmail = google.gmail({ version: "v1", auth: accountFor(email).client });
      const fmt = format ?? "metadata";
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: max_results ?? 20,
        pageToken: page_token,
      });
      const ids = listRes.data.messages ?? [];
      if (fmt === "ids" || ids.length === 0) {
        return asText({
          messages: ids,
          nextPageToken: listRes.data.nextPageToken ?? null,
          resultSizeEstimate: listRes.data.resultSizeEstimate ?? 0,
        });
      }
      const enriched = await pMap(ids, 10, async (m) => {
        const r = await gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "metadata",
          metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
        });
        const h = pickHeaders(r.data.payload?.headers, ["From", "To", "Cc", "Subject", "Date"]);
        return {
          id: r.data.id,
          threadId: r.data.threadId,
          labelIds: r.data.labelIds ?? [],
          snippet: r.data.snippet,
          internalDate: r.data.internalDate,
          from: h["From"],
          to: h["To"],
          cc: h["Cc"],
          subject: h["Subject"],
          date: h["Date"],
          hasAttachments: hasAttachment(r.data.payload ?? undefined),
        };
      });
      return asText({
        messages: enriched,
        nextPageToken: listRes.data.nextPageToken ?? null,
        resultSizeEstimate: listRes.data.resultSizeEstimate ?? 0,
      });
    },
  );

  server.tool(
    "gmail_get_message",
    "Fetch a single Gmail message by ID with headers and decoded text body.",
    {
      email: accountEmailSchema,
      id: z.string(),
      format: z
        .enum(["full", "metadata", "minimal"])
        .optional()
        .describe("Default 'full'"),
    },
    async ({ email, id, format }) => {
      const gmail = google.gmail({ version: "v1", auth: accountFor(email).client });
      const res = await gmail.users.messages.get({
        userId: "me",
        id,
        format: format ?? "full",
      });
      return asText(summarizeMessage(res.data));
    },
  );

  server.tool(
    "gmail_get_thread",
    "Fetch an entire Gmail thread by ID with all messages in order.",
    { email: accountEmailSchema, id: z.string() },
    async ({ email, id }) => {
      const gmail = google.gmail({ version: "v1", auth: accountFor(email).client });
      const res = await gmail.users.threads.get({ userId: "me", id, format: "full" });
      return asText({
        id: res.data.id,
        historyId: res.data.historyId,
        messages: (res.data.messages ?? []).map(summarizeMessage),
      });
    },
  );

  server.tool(
    "gmail_list_labels",
    "List all Gmail labels (system and user).",
    { email: accountEmailSchema },
    async ({ email }) => {
      const gmail = google.gmail({ version: "v1", auth: accountFor(email).client });
      const res = await gmail.users.labels.list({ userId: "me" });
      return asText(res.data.labels ?? []);
    },
  );

  if (enableWrite) {
    server.tool(
      "gmail_modify_labels",
      "Add or remove labels on a message (e.g. mark as read by removing UNREAD, or archive by removing INBOX). Available only when GMAIL_ENABLE_WRITE=true.",
      {
        email: accountEmailSchema,
        message_id: z.string(),
        add_label_ids: z.array(z.string()).optional(),
        remove_label_ids: z.array(z.string()).optional(),
      },
      async ({ email, message_id, add_label_ids, remove_label_ids }) => {
        const gmail = google.gmail({ version: "v1", auth: accountFor(email).client });
        const res = await gmail.users.messages.modify({
          userId: "me",
          id: message_id,
          requestBody: {
            addLabelIds: add_label_ids,
            removeLabelIds: remove_label_ids,
          },
        });
        return asText({ id: res.data.id, labelIds: res.data.labelIds });
      },
    );
  }
}
