import { google, gmail_v1 } from "googleapis";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureAuthorized } from "../auth.js";

type AttachmentRef = {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

function walkAttachments(
  part: gmail_v1.Schema$MessagePart | undefined,
  out: AttachmentRef[],
): void {
  if (!part) return;
  if (part.body?.attachmentId && part.filename) {
    out.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body.size ?? 0,
    });
  }
  if (part.parts) {
    for (const p of part.parts) walkAttachments(p, out);
  }
}

function sanitize(name: string): string {
  return name.replace(/[/\\\0]/g, "_").replace(/^\.+/, "_");
}

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function pickHeaders(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  names: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const h of headers) {
    if (h.name && wanted.has(h.name.toLowerCase()) && h.value) out[h.name] = h.value;
  }
  return out;
}

type WalkedParts = {
  textBody: string;
  htmlBody: string;
  attachments: AttachmentRef[];
};

function walkParts(root: gmail_v1.Schema$MessagePart | undefined): WalkedParts {
  const result: WalkedParts = { textBody: "", htmlBody: "", attachments: [] };
  const visit = (p: gmail_v1.Schema$MessagePart | undefined): void => {
    if (!p) return;
    if (p.body?.attachmentId && p.filename) {
      result.attachments.push({
        attachmentId: p.body.attachmentId,
        filename: p.filename,
        mimeType: p.mimeType ?? "application/octet-stream",
        size: p.body.size ?? 0,
      });
    } else if (p.mimeType === "text/plain" && p.body?.data && !result.textBody) {
      result.textBody = Buffer.from(p.body.data, "base64url").toString("utf8");
    } else if (p.mimeType === "text/html" && p.body?.data && !result.htmlBody) {
      result.htmlBody = Buffer.from(p.body.data, "base64url").toString("utf8");
    }
    if (p.parts) for (const c of p.parts) visit(c);
  };
  visit(root);
  return result;
}

async function collectMessageIds(
  gmail: gmail_v1.Gmail,
  query: string,
  cap: number,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(100, cap - ids.length),
      pageToken,
    });
    for (const m of res.data.messages ?? []) {
      if (m.id) ids.push(m.id);
      if (ids.length >= cap) break;
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < cap);
  return ids;
}

export function registerGmailAttachmentTools(server: McpServer, auth: OAuth2Client): void {
  const gmail = google.gmail({ version: "v1", auth });

  server.tool(
    "gmail_download_attachments",
    "Download attachments from messages matching a Gmail search query into a destination directory. Files are named `<messageId>__<originalFilename>` to avoid collisions. Returns a summary.",
    {
      query: z.string().describe("Gmail search query (e.g. 'label:DMARC')"),
      dest_dir: z.string().describe("Absolute path to destination directory; created if missing"),
      max_messages: z.number().int().min(1).max(1000).optional().describe("Default 200"),
      mime_type_filter: z
        .string()
        .optional()
        .describe("Optional case-insensitive substring matched against MIME type"),
      filename_filter: z
        .string()
        .optional()
        .describe("Optional case-insensitive substring matched against original filename"),
    },
    async ({ query, dest_dir, max_messages, mime_type_filter, filename_filter }) => {
      ensureAuthorized();

      const dir = resolve(dest_dir);
      await mkdir(dir, { recursive: true });

      const cap = max_messages ?? 200;
      const messageIds = await collectMessageIds(gmail, query, cap);

      const mimeNeedle = mime_type_filter?.toLowerCase();
      const nameNeedle = filename_filter?.toLowerCase();

      let savedCount = 0;
      let totalBytes = 0;
      const messagesWithFiles: Array<{
        message_id: string;
        files: Array<{ path: string; original_filename: string; mime_type: string; bytes: number }>;
      }> = [];

      for (const id of messageIds) {
        const msgRes = await gmail.users.messages.get({ userId: "me", id, format: "full" });
        const refs: AttachmentRef[] = [];
        walkAttachments(msgRes.data.payload ?? undefined, refs);

        const filtered = refs.filter((a) => {
          if (mimeNeedle && !a.mimeType.toLowerCase().includes(mimeNeedle)) return false;
          if (nameNeedle && !a.filename.toLowerCase().includes(nameNeedle)) return false;
          return true;
        });

        const saved: Array<{ path: string; original_filename: string; mime_type: string; bytes: number }> = [];
        for (const att of filtered) {
          const data = await gmail.users.messages.attachments.get({
            userId: "me",
            messageId: id,
            id: att.attachmentId,
          });
          if (!data.data.data) continue;
          const buf = Buffer.from(data.data.data, "base64url");
          const filename = `${id}__${sanitize(att.filename || "attachment")}`;
          const path = join(dir, filename);
          await writeFile(path, buf);
          saved.push({
            path,
            original_filename: att.filename,
            mime_type: att.mimeType,
            bytes: buf.length,
          });
          savedCount++;
          totalBytes += buf.length;
        }
        if (saved.length > 0) {
          messagesWithFiles.push({ message_id: id, files: saved });
        }
      }

      return asText({
        messages_processed: messageIds.length,
        messages_with_saved_files: messagesWithFiles.length,
        files_saved: savedCount,
        total_bytes: totalBytes,
        dest_dir: dir,
        details: messagesWithFiles,
      });
    },
  );

  server.tool(
    "gmail_bulk_modify_labels",
    "Add and/or remove labels on all messages matching a Gmail search query using batchModify (efficient for hundreds of messages). Example: remove_label_ids=['UNREAD'] to bulk mark as read.",
    {
      query: z.string().describe("Gmail search query selecting messages to modify"),
      add_label_ids: z.array(z.string()).optional(),
      remove_label_ids: z.array(z.string()).optional(),
      max_messages: z.number().int().min(1).max(10000).optional().describe("Default 1000"),
    },
    async ({ query, add_label_ids, remove_label_ids, max_messages }) => {
      ensureAuthorized();
      if (!add_label_ids?.length && !remove_label_ids?.length) {
        throw new Error("Specify at least one of add_label_ids or remove_label_ids");
      }
      const cap = max_messages ?? 1000;
      const ids = await collectMessageIds(gmail, query, cap);
      if (ids.length === 0) return asText({ matched: 0, modified: 0 });
      let modified = 0;
      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        await gmail.users.messages.batchModify({
          userId: "me",
          requestBody: {
            ids: chunk,
            addLabelIds: add_label_ids,
            removeLabelIds: remove_label_ids,
          },
        });
        modified += chunk.length;
      }
      return asText({
        matched: ids.length,
        modified,
        add_label_ids: add_label_ids ?? [],
        remove_label_ids: remove_label_ids ?? [],
      });
    },
  );

  server.tool(
    "gmail_bulk_export",
    "Bulk-export messages matching a Gmail search query to a directory. Per message: <dest_dir>/<messageId>/{message.json, body.txt, body.html, attachments/...}. Also writes <dest_dir>/index.json summarizing all exported messages.",
    {
      query: z.string().describe("Gmail search query"),
      dest_dir: z.string().describe("Absolute path; created if missing"),
      max_messages: z.number().int().min(1).max(1000).optional().describe("Default 200"),
      include_attachments: z.boolean().optional().describe("Default true"),
      include_html_body: z.boolean().optional().describe("Default true"),
    },
    async ({ query, dest_dir, max_messages, include_attachments, include_html_body }) => {
      ensureAuthorized();
      const dir = resolve(dest_dir);
      await mkdir(dir, { recursive: true });

      const cap = max_messages ?? 200;
      const wantAttach = include_attachments !== false;
      const wantHtml = include_html_body !== false;

      const messageIds = await collectMessageIds(gmail, query, cap);
      const index: Array<{
        messageId: string;
        threadId: string | null;
        from?: string;
        subject?: string;
        date?: string;
        snippet?: string | null;
        attachmentCount: number;
        labelIds: string[];
        dir: string;
      }> = [];

      let attachmentCount = 0;
      let totalAttachmentBytes = 0;

      for (const id of messageIds) {
        const msgRes = await gmail.users.messages.get({ userId: "me", id, format: "full" });
        const msg = msgRes.data;
        const msgDir = join(dir, id);
        await mkdir(msgDir, { recursive: true });

        const { textBody, htmlBody, attachments } = walkParts(msg.payload ?? undefined);
        const headers = pickHeaders(msg.payload?.headers, [
          "From",
          "To",
          "Cc",
          "Subject",
          "Date",
          "Message-ID",
          "References",
          "In-Reply-To",
          "Reply-To",
        ]);

        const metadata = {
          id: msg.id,
          threadId: msg.threadId,
          labelIds: msg.labelIds ?? [],
          internalDate: msg.internalDate,
          snippet: msg.snippet,
          headers,
          attachments: attachments.map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
          })),
        };
        await writeFile(join(msgDir, "message.json"), JSON.stringify(metadata, null, 2));
        if (textBody) await writeFile(join(msgDir, "body.txt"), textBody);
        if (wantHtml && htmlBody) await writeFile(join(msgDir, "body.html"), htmlBody);

        if (wantAttach && attachments.length > 0) {
          const attachDir = join(msgDir, "attachments");
          await mkdir(attachDir, { recursive: true });
          for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const data = await gmail.users.messages.attachments.get({
              userId: "me",
              messageId: id,
              id: att.attachmentId,
            });
            if (!data.data.data) continue;
            const buf = Buffer.from(data.data.data, "base64url");
            const filename = sanitize(att.filename || `attachment_${i}`);
            await writeFile(join(attachDir, filename), buf);
            attachmentCount++;
            totalAttachmentBytes += buf.length;
          }
        }

        index.push({
          messageId: id,
          threadId: msg.threadId ?? null,
          from: headers["From"],
          subject: headers["Subject"],
          date: headers["Date"],
          snippet: msg.snippet,
          attachmentCount: attachments.length,
          labelIds: msg.labelIds ?? [],
          dir: msgDir,
        });
      }

      await writeFile(join(dir, "index.json"), JSON.stringify(index, null, 2));

      return asText({
        messages_exported: messageIds.length,
        attachments_saved: attachmentCount,
        attachments_total_bytes: totalAttachmentBytes,
        dest_dir: dir,
        index_path: join(dir, "index.json"),
      });
    },
  );
}
