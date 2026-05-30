import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureAuthorized } from "../auth.js";
import { buildRawMessage } from "../util/mime.js";
import { deriveReplyContext } from "../util/threading.js";

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const recipientSchema = z.union([z.string(), z.array(z.string())]);

export function registerGmailDraftTools(server: McpServer, auth: OAuth2Client): void {
  const gmail = google.gmail({ version: "v1", auth });

  server.tool(
    "gmail_list_drafts",
    "List Gmail drafts (most recent first).",
    {
      max_results: z.number().int().min(1).max(100).optional(),
      page_token: z.string().optional(),
    },
    async ({ max_results, page_token }) => {
      ensureAuthorized();
      const res = await gmail.users.drafts.list({
        userId: "me",
        maxResults: max_results ?? 20,
        pageToken: page_token,
      });
      return asText({
        drafts: res.data.drafts ?? [],
        nextPageToken: res.data.nextPageToken ?? null,
      });
    },
  );

  server.tool(
    "gmail_get_draft",
    "Fetch a draft's full content.",
    { id: z.string() },
    async ({ id }) => {
      ensureAuthorized();
      const res = await gmail.users.drafts.get({ userId: "me", id, format: "full" });
      return asText(res.data);
    },
  );

  server.tool(
    "gmail_create_draft",
    "Create a new Gmail draft. Pass reply_to_message_id to thread the draft as a reply (sets In-Reply-To/References and reuses the threadId).",
    {
      to: recipientSchema,
      cc: recipientSchema.optional(),
      bcc: recipientSchema.optional(),
      subject: z.string(),
      body: z.string().describe("Plain text body"),
      reply_to_message_id: z
        .string()
        .optional()
        .describe("If set, draft is threaded as a reply to this message"),
    },
    async ({ to, cc, bcc, subject, body, reply_to_message_id }) => {
      ensureAuthorized();
      let threadId: string | undefined;
      let inReplyTo: string | undefined;
      let references: string[] | undefined;
      let finalSubject = subject;

      if (reply_to_message_id) {
        const src = await gmail.users.messages.get({
          userId: "me",
          id: reply_to_message_id,
          format: "metadata",
          metadataHeaders: ["Message-ID", "References", "Subject", "From", "Reply-To", "Cc"],
        });
        const ctx = deriveReplyContext(src.data);
        threadId = ctx.threadId;
        inReplyTo = ctx.inReplyTo;
        references = ctx.references;
        if (!subject) finalSubject = ctx.subject;
      }

      const raw = buildRawMessage({
        to,
        cc,
        bcc,
        subject: finalSubject,
        body,
        inReplyTo,
        references,
      });

      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: { raw, threadId },
        },
      });
      return asText({ id: res.data.id, message: res.data.message });
    },
  );

  server.tool(
    "gmail_update_draft",
    "Replace a draft's content. All fields except draft_id are required and overwrite existing values.",
    {
      draft_id: z.string(),
      to: recipientSchema,
      cc: recipientSchema.optional(),
      bcc: recipientSchema.optional(),
      subject: z.string(),
      body: z.string(),
      thread_id: z.string().optional(),
      in_reply_to: z.string().optional(),
      references: z.array(z.string()).optional(),
    },
    async ({ draft_id, to, cc, bcc, subject, body, thread_id, in_reply_to, references }) => {
      ensureAuthorized();
      const raw = buildRawMessage({
        to,
        cc,
        bcc,
        subject,
        body,
        inReplyTo: in_reply_to,
        references,
      });
      const res = await gmail.users.drafts.update({
        userId: "me",
        id: draft_id,
        requestBody: { message: { raw, threadId: thread_id } },
      });
      return asText({ id: res.data.id, message: res.data.message });
    },
  );

  server.tool(
    "gmail_delete_draft",
    "Delete a draft by ID.",
    { id: z.string() },
    async ({ id }) => {
      ensureAuthorized();
      await gmail.users.drafts.delete({ userId: "me", id });
      return asText({ ok: true, deleted: id });
    },
  );
}
