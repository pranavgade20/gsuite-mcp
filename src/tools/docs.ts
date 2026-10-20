import { google, docs_v1 } from "googleapis";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { accountEmailSchema, accountFor } from "./common.js";

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function parseDocumentId(input: string): string {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;

  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/);
    if (match) return match[1];
  } catch {
    // The error below gives the caller a more useful parameter-specific message.
  }
  throw new Error("Expected a Google Docs document ID or a docs.google.com/document/d/... URL");
}

function paragraphElementText(element: docs_v1.Schema$ParagraphElement): string {
  if (element.textRun?.content) return element.textRun.content;
  if (element.person?.personProperties) {
    return element.person.personProperties.name ?? element.person.personProperties.email ?? "";
  }
  if (element.richLink?.richLinkProperties) {
    const link = element.richLink.richLinkProperties;
    return link.title ?? link.uri ?? "";
  }
  if (element.footnoteReference) {
    const number = element.footnoteReference.footnoteNumber;
    return number ? `[${number}]` : "[footnote]";
  }
  if (element.inlineObjectElement) return "[image]";
  if (element.equation) return "[equation]";
  if (element.horizontalRule) return "\n---\n";
  if (element.pageBreak) return "\f";
  if (element.columnBreak) return "\n";
  return "";
}

function paragraphText(paragraph: docs_v1.Schema$Paragraph): string {
  const content = (paragraph.elements ?? []).map(paragraphElementText).join("");
  if (!paragraph.bullet || !content.trim()) return content;
  const nestingLevel = paragraph.bullet.nestingLevel ?? 0;
  return `${"  ".repeat(nestingLevel)}• ${content}`;
}

export function structuralElementsText(
  elements: docs_v1.Schema$StructuralElement[] | null | undefined,
): string {
  if (!elements) return "";
  return elements
    .map((element) => {
      if (element.paragraph) return paragraphText(element.paragraph);
      if (element.table) {
        const rows = (element.table.tableRows ?? []).map((row) =>
          (row.tableCells ?? [])
            .map((cell) => structuralElementsText(cell.content).trimEnd())
            .join("\t"),
        );
        return `${rows.join("\n")}\n`;
      }
      if (element.tableOfContents) {
        return structuralElementsText(element.tableOfContents.content);
      }
      return "";
    })
    .join("");
}

type ReadTab = {
  id: string | null;
  title: string;
  parent_tab_id: string | null;
  text: string;
};

function documentTabText(tab: docs_v1.Schema$DocumentTab): string {
  let text = structuralElementsText(tab.body?.content);
  const footnotes = Object.values(tab.footnotes ?? {});
  if (footnotes.length > 0) {
    const rendered = footnotes
      .map((footnote) => {
        const note = structuralElementsText(footnote.content).trim();
        return note ? `[${footnote.footnoteId ?? "footnote"}] ${note}` : "";
      })
      .filter(Boolean);
    if (rendered.length > 0) text += `\n${rendered.join("\n")}\n`;
  }
  return text;
}

function flattenTabs(
  tabs: docs_v1.Schema$Tab[] | null | undefined,
  parentTabId: string | null = null,
): ReadTab[] {
  const flattened: ReadTab[] = [];
  for (const tab of tabs ?? []) {
    const id = tab.tabProperties?.tabId ?? null;
    flattened.push({
      id,
      title: tab.tabProperties?.title ?? "Untitled tab",
      parent_tab_id: parentTabId,
      text: tab.documentTab ? documentTabText(tab.documentTab) : "",
    });
    flattened.push(...flattenTabs(tab.childTabs, id));
  }
  return flattened;
}

export function registerDocsTools(server: McpServer, enableWrite = false): void {
  const documentSchema = z
    .string()
    .describe("A Google Docs document ID or full docs.google.com document URL");

  server.tool(
    "docs_get_document",
    "Fetch a Google Doc as the full structured Google Docs API document, including all document tabs by default.",
    {
      email: accountEmailSchema,
      document_id_or_url: documentSchema,
      include_tabs_content: z.boolean().optional().describe("Default true"),
    },
    async ({ email, document_id_or_url, include_tabs_content }) => {
      const account = accountFor(email);
      const docs = google.docs({ version: "v1", auth: account.client });
      const result = await docs.documents.get({
        documentId: parseDocumentId(document_id_or_url),
        includeTabsContent: include_tabs_content ?? true,
      });
      return asText({ account_email: account.email, document: result.data });
    },
  );

  server.tool(
    "docs_read_document",
    "Read the text of a Google Doc. Returns plain text for each tab (including nested tabs), plus combined text and document metadata. Tables are rendered as tab-separated rows.",
    {
      email: accountEmailSchema,
      document_id_or_url: documentSchema,
    },
    async ({ email, document_id_or_url }) => {
      const account = accountFor(email);
      const docs = google.docs({ version: "v1", auth: account.client });
      const result = await docs.documents.get({
        documentId: parseDocumentId(document_id_or_url),
        includeTabsContent: true,
      });
      const document = result.data;
      let tabs = flattenTabs(document.tabs);
      if (tabs.length === 0) {
        tabs = [
          {
            id: null,
            title: document.title ?? "Document",
            parent_tab_id: null,
            text: structuralElementsText(document.body?.content),
          },
        ];
      }
      const combinedText =
        tabs.length === 1
          ? tabs[0].text
          : tabs.map((tab) => `# ${tab.title}\n\n${tab.text}`).join("\n");
      return asText({
        account_email: account.email,
        document_id: document.documentId,
        title: document.title,
        revision_id: document.revisionId,
        tabs,
        text: combinedText,
      });
    },
  );

  if (!enableWrite) return;

  server.tool(
    "docs_create_document",
    "Create a Google Doc, optionally with initial plain-text content. Available only when DOCS_ENABLE_WRITE=true.",
    {
      email: accountEmailSchema,
      title: z.string().min(1).describe("Document title"),
      initial_text: z.string().optional().describe("Optional initial plain-text body"),
    },
    async ({ email, title, initial_text }) => {
      const account = accountFor(email);
      const docs = google.docs({ version: "v1", auth: account.client });
      const created = await docs.documents.create({ requestBody: { title } });
      const documentId = created.data.documentId;
      if (!documentId) throw new Error("Google created the document without returning its ID");

      if (initial_text) {
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{ insertText: { location: { index: 1 }, text: initial_text } }],
          },
        });
      }

      return asText({
        account_email: account.email,
        document_id: documentId,
        title: created.data.title,
        url: `https://docs.google.com/document/d/${documentId}/edit`,
      });
    },
  );

  server.tool(
    "docs_insert_text",
    "Insert plain text into a Google Doc. Omit `index` to append to the selected tab's body; provide an index to insert at an exact Docs API position.",
    {
      email: accountEmailSchema,
      document_id_or_url: documentSchema,
      text: z.string().min(1),
      index: z.number().int().min(1).optional(),
      tab_id: z.string().optional().describe("Optional document tab ID"),
    },
    async ({ email, document_id_or_url, text, index, tab_id }) => {
      const account = accountFor(email);
      const docs = google.docs({ version: "v1", auth: account.client });
      const documentId = parseDocumentId(document_id_or_url);
      const insertText: docs_v1.Schema$InsertTextRequest = {
        text,
        ...(index === undefined
          ? { endOfSegmentLocation: { tabId: tab_id } }
          : { location: { index, tabId: tab_id } }),
      };
      const result = await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests: [{ insertText }] },
      });
      return asText({
        account_email: account.email,
        document_id: documentId,
        inserted_characters: text.length,
        write_control: result.data.writeControl,
      });
    },
  );

  server.tool(
    "docs_replace_all_text",
    "Replace every occurrence of text in a Google Doc. Can target all tabs or an explicit list of tab IDs.",
    {
      email: accountEmailSchema,
      document_id_or_url: documentSchema,
      find_text: z.string().min(1),
      replace_text: z.string(),
      match_case: z.boolean().optional().describe("Default false"),
      tab_ids: z.array(z.string()).min(1).optional(),
    },
    async ({ email, document_id_or_url, find_text, replace_text, match_case, tab_ids }) => {
      const account = accountFor(email);
      const docs = google.docs({ version: "v1", auth: account.client });
      const documentId = parseDocumentId(document_id_or_url);
      const result = await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              replaceAllText: {
                containsText: { text: find_text, matchCase: match_case ?? false },
                replaceText: replace_text,
                tabsCriteria: tab_ids ? { tabIds: tab_ids } : undefined,
              },
            },
          ],
        },
      });
      const occurrencesChanged = result.data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0;
      return asText({
        account_email: account.email,
        document_id: documentId,
        occurrences_changed: occurrencesChanged,
        write_control: result.data.writeControl,
      });
    },
  );

  server.tool(
    "docs_batch_update",
    "Apply advanced Google Docs API batchUpdate requests for formatting, ranges, tables, images, and other supported edits. Use the Google Docs API request object format.",
    {
      email: accountEmailSchema,
      document_id_or_url: documentSchema,
      requests: z.array(z.record(z.unknown())).min(1),
      required_revision_id: z.string().optional(),
      target_revision_id: z.string().optional(),
    },
    async ({
      email,
      document_id_or_url,
      requests,
      required_revision_id,
      target_revision_id,
    }) => {
      if (required_revision_id && target_revision_id) {
        throw new Error("Specify only one of required_revision_id or target_revision_id");
      }
      const account = accountFor(email);
      const docs = google.docs({ version: "v1", auth: account.client });
      const documentId = parseDocumentId(document_id_or_url);
      const writeControl =
        required_revision_id || target_revision_id
          ? {
              requiredRevisionId: required_revision_id,
              targetRevisionId: target_revision_id,
            }
          : undefined;
      const result = await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: requests as docs_v1.Schema$Request[],
          writeControl,
        },
      });
      return asText({
        account_email: account.email,
        document_id: documentId,
        replies: result.data.replies ?? [],
        write_control: result.data.writeControl,
      });
    },
  );
}
