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

export function registerGmailSendTools(server: McpServer, auth: OAuth2Client): void {
  const gmail = google.gmail({ version: "v1", auth });

  server.tool(
    "gmail_send_message",
    "Send a new Gmail message immediately. Available only when GMAIL_ENABLE_SEND=true.",
    {
      to: recipientSchema,
      cc: recipientSchema.optional(),
      bcc: recipientSchema.optional(),
      subject: z.string(),
      body: z.string(),
      reply_to_message_id: z.string().optional(),
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
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw, threadId },
      });
      return asText({ id: res.data.id, threadId: res.data.threadId, labelIds: res.data.labelIds });
    },
  );

  server.tool(
    "gmail_send_draft",
    "Send an existing draft by ID. Available only when GMAIL_ENABLE_SEND=true.",
    { draft_id: z.string() },
    async ({ draft_id }) => {
      ensureAuthorized();
      const res = await gmail.users.drafts.send({
        userId: "me",
        requestBody: { id: draft_id },
      });
      return asText({ id: res.data.id, threadId: res.data.threadId });
    },
  );
}
