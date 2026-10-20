import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { google, drive_v3 } from "googleapis";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { accountEmailSchema, accountFor } from "./common.js";

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";

const FILE_FIELDS = [
  "id",
  "name",
  "mimeType",
  "description",
  "parents",
  "driveId",
  "size",
  "createdTime",
  "modifiedTime",
  "viewedByMeTime",
  "webViewLink",
  "webContentLink",
  "iconLink",
  "thumbnailLink",
  "starred",
  "trashed",
  "shared",
  "ownedByMe",
  "owners(displayName,emailAddress)",
  "lastModifyingUser(displayName,emailAddress)",
  "capabilities(canDownload,canEdit,canShare,canAddChildren)",
  "shortcutDetails(targetId,targetMimeType)",
  "fileExtension",
  "fullFileExtension",
  "md5Checksum",
  "exportLinks",
].join(",");

const DEFAULT_EXPORT_MIME_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/svg+xml",
  "application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function parseDriveFileId(input: string): string {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;

  try {
    const url = new URL(value);
    const queryId = url.searchParams.get("id");
    if (queryId && /^[A-Za-z0-9_-]+$/.test(queryId)) return queryId;

    const match = url.pathname.match(
      /\/(?:drive\/(?:u\/\d+\/)?folders|file\/(?:u\/\d+\/)?d|(?:document|spreadsheets|presentation|drawings|forms)\/(?:u\/\d+\/)?d)\/([A-Za-z0-9_-]+)/,
    );
    if (match) return match[1];
  } catch {
    // The parameter-specific error below is more useful than URL parsing details.
  }

  throw new Error(
    "Expected a Google Drive file/folder ID or a Google Drive, Docs, Sheets, or Slides URL",
  );
}

export function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function listFields(): string {
  return `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`;
}

function listRequestOptions(driveId?: string) {
  return {
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...(driveId ? { corpora: "drive", driveId } : { corpora: "user" }),
  };
}

function isGoogleWorkspaceFile(mimeType: string): boolean {
  return (
    mimeType.startsWith(GOOGLE_APPS_PREFIX) &&
    mimeType !== FOLDER_MIME_TYPE &&
    mimeType !== SHORTCUT_MIME_TYPE
  );
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/ld+json" ||
    mimeType === "application/xml" ||
    mimeType === "application/javascript" ||
    mimeType === "application/x-javascript" ||
    mimeType === "application/yaml" ||
    mimeType === "application/x-yaml" ||
    mimeType === "application/sql" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

function responseDataToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error("Google Drive returned file content in an unsupported response format");
}

async function getFileMetadata(drive: drive_v3.Drive, fileId: string) {
  const result = await drive.files.get({
    fileId,
    supportsAllDrives: true,
    fields: FILE_FIELDS,
  });
  return result.data;
}

function exportMimeTypeFor(file: drive_v3.Schema$File, requested?: string): string {
  const mimeType = file.mimeType ?? "";
  if (requested) return requested;
  const defaultMimeType = DEFAULT_EXPORT_MIME_TYPES[mimeType];
  if (defaultMimeType) return defaultMimeType;
  throw new Error(
    `Google Workspace file type ${mimeType || "unknown"} needs an explicit export_mime_type`,
  );
}

async function getFileContent(
  drive: drive_v3.Drive,
  file: drive_v3.Schema$File,
  requestedExportMimeType?: string,
): Promise<{ buffer: Buffer; contentMimeType: string; exported: boolean }> {
  if (!file.id) throw new Error("Google Drive returned file metadata without an ID");
  if (file.mimeType === FOLDER_MIME_TYPE) {
    throw new Error("Folders do not have downloadable content; use drive_list_folder instead");
  }
  if (file.mimeType === SHORTCUT_MIME_TYPE) {
    throw new Error(
      `This item is a shortcut; access its target ID instead: ${file.shortcutDetails?.targetId ?? "unknown"}`,
    );
  }
  if (file.capabilities?.canDownload === false) {
    throw new Error("The current account is not allowed to download this file");
  }

  if (isGoogleWorkspaceFile(file.mimeType ?? "")) {
    const contentMimeType = exportMimeTypeFor(file, requestedExportMimeType);
    const result = await drive.files.export(
      { fileId: file.id, mimeType: contentMimeType },
      { responseType: "arraybuffer" },
    );
    return { buffer: responseDataToBuffer(result.data), contentMimeType, exported: true };
  }

  const result = await drive.files.get(
    { fileId: file.id, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return {
    buffer: responseDataToBuffer(result.data),
    contentMimeType: file.mimeType ?? "application/octet-stream",
    exported: false,
  };
}

export function registerDriveTools(server: McpServer, allowLocalFiles = true): void {
  const itemSchema = z
    .string()
    .describe("A Google Drive file/folder ID or a Google Drive/Workspace URL");
  const pageSizeSchema = z.number().int().min(1).max(1000).optional().describe("Default 100");

  server.tool(
    "drive_list_folder",
    "List the direct children of a Google Drive folder, including folders, files, and shortcuts. Supports My Drive and shared drives. Omit folder_id_or_url to list My Drive's root.",
    {
      email: accountEmailSchema,
      folder_id_or_url: itemSchema.optional().describe("Default: My Drive root"),
      drive_id: z
        .string()
        .optional()
        .describe("Optional shared drive ID; narrows the corpus for better performance"),
      page_size: pageSizeSchema,
      page_token: z.string().optional(),
      order_by: z
        .string()
        .optional()
        .describe("Drive orderBy expression; default 'folder,name_natural'"),
      name_contains: z.string().optional().describe("Optional case-insensitive name substring filter"),
      folders_only: z.boolean().optional().describe("Default false"),
      include_trashed: z.boolean().optional().describe("Default false"),
    },
    async ({
      email,
      folder_id_or_url,
      drive_id,
      page_size,
      page_token,
      order_by,
      name_contains,
      folders_only,
      include_trashed,
    }) => {
      const account = accountFor(email);
      const drive = google.drive({ version: "v3", auth: account.client });
      const folderId = folder_id_or_url ? parseDriveFileId(folder_id_or_url) : "root";
      const query = [`'${folderId}' in parents`];
      if (!include_trashed) query.push("trashed = false");
      if (folders_only) query.push(`mimeType = '${FOLDER_MIME_TYPE}'`);
      if (name_contains) {
        query.push(`name contains '${escapeDriveQueryLiteral(name_contains)}'`);
      }

      const result = await drive.files.list({
        ...listRequestOptions(drive_id),
        q: query.join(" and "),
        pageSize: page_size ?? 100,
        pageToken: page_token,
        orderBy: order_by ?? "folder,name_natural",
        spaces: "drive",
        fields: listFields(),
      });
      return asText({
        account_email: account.email,
        folder_id: folderId,
        files: result.data.files ?? [],
        next_page_token: result.data.nextPageToken ?? null,
        incomplete_search: result.data.incompleteSearch ?? false,
      });
    },
  );

  server.tool(
    "drive_search_files",
    "Search Google Drive files and folders with Google Drive API query syntax (for example: `name contains 'report'`, `fullText contains 'quarterly'`, `mimeType = 'application/pdf'`, or `sharedWithMe`). Includes My Drive and shared-drive items.",
    {
      email: accountEmailSchema,
      query: z.string().min(1).describe("Google Drive API `q` expression"),
      drive_id: z
        .string()
        .optional()
        .describe("Optional shared drive ID; searches only that shared drive"),
      corpora: z
        .enum(["user", "domain", "allDrives"])
        .optional()
        .describe("Ignored when drive_id is supplied; default 'user'"),
      page_size: pageSizeSchema,
      page_token: z.string().optional(),
      order_by: z.string().optional().describe("Drive orderBy expression; default 'recency desc'"),
      include_trashed: z.boolean().optional().describe("Default false"),
    },
    async ({
      email,
      query,
      drive_id,
      corpora,
      page_size,
      page_token,
      order_by,
      include_trashed,
    }) => {
      const account = accountFor(email);
      const drive = google.drive({ version: "v3", auth: account.client });
      const effectiveQuery = include_trashed ? query : `(${query}) and trashed = false`;
      const result = await drive.files.list({
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        ...(drive_id ? { corpora: "drive", driveId: drive_id } : { corpora: corpora ?? "user" }),
        q: effectiveQuery,
        pageSize: page_size ?? 100,
        pageToken: page_token,
        orderBy: order_by ?? "recency desc",
        spaces: "drive",
        fields: listFields(),
      });
      return asText({
        account_email: account.email,
        query: effectiveQuery,
        files: result.data.files ?? [],
        next_page_token: result.data.nextPageToken ?? null,
        incomplete_search: result.data.incompleteSearch ?? false,
      });
    },
  );

  server.tool(
    "drive_get_file",
    "Get detailed metadata for a Google Drive file, folder, or shortcut.",
    {
      email: accountEmailSchema,
      file_id_or_url: itemSchema,
    },
    async ({ email, file_id_or_url }) => {
      const account = accountFor(email);
      const drive = google.drive({ version: "v3", auth: account.client });
      const file = await getFileMetadata(drive, parseDriveFileId(file_id_or_url));
      return asText({ account_email: account.email, file });
    },
  );

  server.tool(
    "drive_read_file",
    "Read a text file from Google Drive. Native Docs, Sheets, and Slides are exported to plain text/CSV by default. Binary files should be saved with drive_download_file instead.",
    {
      email: accountEmailSchema,
      file_id_or_url: itemSchema,
      export_mime_type: z
        .string()
        .optional()
        .describe("Optional export MIME type for a native Google Workspace file"),
      max_characters: z
        .number()
        .int()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe("Maximum characters returned; default 200000"),
    },
    async ({ email, file_id_or_url, export_mime_type, max_characters }) => {
      const account = accountFor(email);
      const drive = google.drive({ version: "v3", auth: account.client });
      const file = await getFileMetadata(drive, parseDriveFileId(file_id_or_url));
      const requestedMimeType =
        export_mime_type ??
        (isGoogleWorkspaceFile(file.mimeType ?? "")
          ? DEFAULT_EXPORT_MIME_TYPES[file.mimeType ?? ""]
          : file.mimeType ?? "application/octet-stream");
      if (requestedMimeType && !isTextMimeType(requestedMimeType)) {
        throw new Error(
          `MIME type ${requestedMimeType} is not text-readable; use drive_download_file instead`,
        );
      }

      const content = await getFileContent(drive, file, export_mime_type);
      const text = content.buffer.toString("utf8");
      const limit = max_characters ?? 200_000;
      return asText({
        account_email: account.email,
        file,
        content_mime_type: content.contentMimeType,
        exported: content.exported,
        bytes: content.buffer.length,
        total_characters: text.length,
        truncated: text.length > limit,
        text: text.slice(0, limit),
      });
    },
  );

  if (allowLocalFiles) server.tool(
    "drive_download_file",
    "Download a Drive file to an exact local path. Native Google Workspace files are exported (Docs as text, Sheets as CSV, Slides as text) unless export_mime_type is specified.",
    {
      email: accountEmailSchema,
      file_id_or_url: itemSchema,
      dest_path: z.string().describe("Absolute local output file path; parent directories are created"),
      export_mime_type: z
        .string()
        .optional()
        .describe("Optional export MIME type for a native Google Workspace file"),
    },
    async ({ email, file_id_or_url, dest_path, export_mime_type }) => {
      if (!isAbsolute(dest_path)) throw new Error("dest_path must be an absolute path");
      const account = accountFor(email);
      const drive = google.drive({ version: "v3", auth: account.client });
      const file = await getFileMetadata(drive, parseDriveFileId(file_id_or_url));
      const content = await getFileContent(drive, file, export_mime_type);
      const outputPath = resolve(dest_path);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, content.buffer);
      return asText({
        account_email: account.email,
        file_id: file.id,
        name: file.name,
        source_mime_type: file.mimeType,
        content_mime_type: content.contentMimeType,
        exported: content.exported,
        bytes: content.buffer.length,
        path: outputPath,
      });
    },
  );

  server.tool(
    "drive_list_shared_drives",
    "List shared drives that the selected Google account can access.",
    {
      email: accountEmailSchema,
      page_size: z.number().int().min(1).max(100).optional().describe("Default 100"),
      page_token: z.string().optional(),
      query: z
        .string()
        .optional()
        .describe("Optional shared-drive query, such as `name contains 'Engineering'`"),
    },
    async ({ email, page_size, page_token, query }) => {
      const account = accountFor(email);
      const drive = google.drive({ version: "v3", auth: account.client });
      const result = await drive.drives.list({
        pageSize: page_size ?? 100,
        pageToken: page_token,
        q: query,
        fields:
          "nextPageToken,drives(id,name,createdTime,hidden,capabilities(canAddChildren,canComment,canCopy,canDeleteDrive,canDownload,canEdit,canListChildren,canManageMembers,canRename,canShare))",
      });
      return asText({
        account_email: account.email,
        drives: result.data.drives ?? [],
        next_page_token: result.data.nextPageToken ?? null,
      });
    },
  );
}
