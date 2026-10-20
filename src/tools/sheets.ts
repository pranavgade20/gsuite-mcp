import { google, sheets_v4 } from "googleapis";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { accountEmailSchema, accountFor } from "./common.js";

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function parseSpreadsheetId(input: string): string {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;

  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|$)/);
    if (["https:", "http:"].includes(url.protocol) && url.hostname === "docs.google.com" && match && match[1] !== "e") {
      return match[1];
    }
  } catch {
    // Give the caller a parameter-specific error below.
  }
  throw new Error("Expected a Google Sheets spreadsheet ID or a docs.google.com/spreadsheets/d/... URL");
}

async function withSheets(
  email: string | undefined,
  action: (sheets: sheets_v4.Sheets) => Promise<unknown>,
) {
  const account = accountFor(email);
  const sheets = google.sheets({ version: "v4", auth: account.client });
  try {
    return asText({ account_email: account.email, ...(await action(sheets) as object) });
  } catch (error) {
    const apiError = error as {
      response?: { data?: { error?: {
        errors?: Array<{ reason?: string }>;
        details?: Array<{ reason?: string }>;
      } } };
    } | null;
    const details = apiError?.response?.data?.error;
    const reasons = [...(details?.errors ?? []), ...(details?.details ?? [])].map((item) => item.reason);
    if (reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || reasons.includes("insufficientPermissions")) {
      throw new Error(
        `Google Sheets permission is missing for ${account.email}. Call setup_auth with this email ` +
        "and complete consent for the requested scopes, then retry.",
      );
    }
    if (reasons.includes("SERVICE_DISABLED") || reasons.includes("accessNotConfigured")) {
      throw new Error("Enable the Google Sheets API in the OAuth client's Google Cloud project, then retry.");
    }
    throw error;
  }
}

export function registerSheetsTools(server: McpServer, enableWrite = false): void {
  const spreadsheetSchema = z.string().min(1).describe(
    "Google Sheets spreadsheet ID or full docs.google.com/spreadsheets URL. The URL's gid does not select a tab; use a sheet-qualified range.",
  );
  const rangeSchema = z.string().trim().min(1).describe(
    "A1 range, for example 'Sheet 1'!A1:D20, or a named range. Quote tab names containing spaces or special characters.",
  );
  const dimensionSchema = z.enum(["ROWS", "COLUMNS"]).optional().describe("Default ROWS");
  const valuesSchema = z.array(z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()]))).min(1)
    .describe("Two-dimensional cell values. null skips a cell; an empty string clears it. Trailing empty rows/columns may be omitted.");
  const inputSchema = z.enum(["RAW", "USER_ENTERED"]).optional()
    .describe("Default RAW: store literal values. USER_ENTERED parses formulas, dates, and numbers as if typed in Sheets.");

  server.tool(
    "sheets_get_spreadsheet",
    "Get spreadsheet metadata, tab titles/IDs, dimensions, named ranges, and other properties. Cell grid data is excluded by default; enable it for formatting and restrict ranges for large spreadsheets. Discover spreadsheet IDs with drive_search_files using mimeType = 'application/vnd.google-apps.spreadsheet'.",
    {
      email: accountEmailSchema,
      spreadsheet_id_or_url: spreadsheetSchema,
      ranges: z.array(rangeSchema).min(1).optional(),
      include_grid_data: z.boolean().optional().describe("Default false; true includes cell data and formatting"),
    },
    async ({ email, spreadsheet_id_or_url, ranges, include_grid_data }) => withSheets(email, async (sheets) => {
      const result = await sheets.spreadsheets.get({
        spreadsheetId: parseSpreadsheetId(spreadsheet_id_or_url),
        ranges,
        includeGridData: include_grid_data ?? false,
      });
      return { spreadsheet: result.data };
    }),
  );

  server.tool(
    "sheets_read_values",
    "Read one or more ranges across spreadsheet tabs in one request. Returns valueRanges in requested order, with trailing empty rows/columns omitted. Choose FORMULA to inspect formulas or UNFORMATTED_VALUE for calculated numbers.",
    {
      email: accountEmailSchema,
      spreadsheet_id_or_url: spreadsheetSchema,
      ranges: z.array(rangeSchema).min(1),
      major_dimension: dimensionSchema,
      value_render_option: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).optional()
        .describe("Default FORMATTED_VALUE"),
      date_time_render_option: z.enum(["SERIAL_NUMBER", "FORMATTED_STRING"]).optional()
        .describe("Default SERIAL_NUMBER; ignored when value_render_option is FORMATTED_VALUE"),
    },
    async ({ email, spreadsheet_id_or_url, ranges, major_dimension, value_render_option, date_time_render_option }) =>
      withSheets(email, async (sheets) => {
        const result = await sheets.spreadsheets.values.batchGet({
          spreadsheetId: parseSpreadsheetId(spreadsheet_id_or_url),
          ranges,
          majorDimension: major_dimension ?? "ROWS",
          valueRenderOption: value_render_option ?? "FORMATTED_VALUE",
          dateTimeRenderOption: date_time_render_option ?? "SERIAL_NUMBER",
        });
        return { spreadsheet_id: result.data.spreadsheetId, value_ranges: result.data.valueRanges ?? [] };
      }),
  );

  if (!enableWrite) return;

  server.tool(
    "sheets_create_spreadsheet",
    "Create a Google spreadsheet with optional named tabs. Returns its URL and tab IDs. Available only when SHEETS_ENABLE_WRITE=true.",
    {
      email: accountEmailSchema,
      title: z.string().trim().min(1),
      sheet_titles: z.array(z.string().min(1)).min(1).optional().describe("Omit for Google's default initial tab"),
      locale: z.string().min(1).optional().describe("Spreadsheet locale, for example en_US"),
      time_zone: z.string().min(1).optional().describe("Time zone, for example Europe/London"),
    },
    async ({ email, title, sheet_titles, locale, time_zone }) => withSheets(email, async (sheets) => {
      const result = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title, locale, timeZone: time_zone },
          sheets: sheet_titles?.map((sheetTitle) => ({ properties: { title: sheetTitle } })),
        },
      });
      return { spreadsheet: result.data };
    }),
  );

  server.tool(
    "sheets_write_values",
    "Write cell values to one or more explicit ranges in a single request. Overwrites supplied cells. Default RAW preserves strings literally; choose USER_ENTERED to write formulas. Available only when SHEETS_ENABLE_WRITE=true.",
    {
      email: accountEmailSchema,
      spreadsheet_id_or_url: spreadsheetSchema,
      data: z.array(z.object({ range: rangeSchema, values: valuesSchema, major_dimension: dimensionSchema })).min(1),
      value_input_option: inputSchema,
      include_values_in_response: z.boolean().optional().describe("Default false"),
    },
    async ({ email, spreadsheet_id_or_url, data, value_input_option, include_values_in_response }) =>
      withSheets(email, async (sheets) => {
        const result = await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId: parseSpreadsheetId(spreadsheet_id_or_url),
          requestBody: {
            valueInputOption: value_input_option ?? "RAW",
            includeValuesInResponse: include_values_in_response ?? false,
            data: data.map(({ range, values, major_dimension }) => ({ range, values, majorDimension: major_dimension ?? "ROWS" })),
          },
        });
        return { result: result.data };
      }),
  );

  server.tool(
    "sheets_append_values",
    "Append values after the last row of the logical table found in the specified range. The range locates the table, not an exact destination cell. Defaults to inserting rows with literal values. Available only when SHEETS_ENABLE_WRITE=true.",
    {
      email: accountEmailSchema,
      spreadsheet_id_or_url: spreadsheetSchema,
      range: rangeSchema,
      values: valuesSchema,
      major_dimension: dimensionSchema,
      value_input_option: inputSchema,
      insert_data_option: z.enum(["INSERT_ROWS", "OVERWRITE"]).optional().describe("Default INSERT_ROWS"),
      include_values_in_response: z.boolean().optional().describe("Default false"),
    },
    async ({ email, spreadsheet_id_or_url, range, values, major_dimension, value_input_option, insert_data_option, include_values_in_response }) =>
      withSheets(email, async (sheets) => {
        const result = await sheets.spreadsheets.values.append({
          spreadsheetId: parseSpreadsheetId(spreadsheet_id_or_url),
          range,
          valueInputOption: value_input_option ?? "RAW",
          insertDataOption: insert_data_option ?? "INSERT_ROWS",
          includeValuesInResponse: include_values_in_response ?? false,
          requestBody: { range, majorDimension: major_dimension ?? "ROWS", values },
        });
        return { result: result.data };
      }),
  );

  server.tool(
    "sheets_clear_values",
    "Clear cell values in one or more ranges, preserving formatting and data validation. Available only when SHEETS_ENABLE_WRITE=true.",
    { email: accountEmailSchema, spreadsheet_id_or_url: spreadsheetSchema, ranges: z.array(rangeSchema).min(1) },
    async ({ email, spreadsheet_id_or_url, ranges }) => withSheets(email, async (sheets) => {
      const result = await sheets.spreadsheets.values.batchClear({
        spreadsheetId: parseSpreadsheetId(spreadsheet_id_or_url),
        requestBody: { ranges },
      });
      return { result: result.data };
    }),
  );

  server.tool(
    "sheets_batch_update",
    "Apply advanced Google Sheets API batchUpdate requests: add/rename/delete tabs, insert/delete rows or columns, formatting, filters, validation, charts, and more. Use Sheets API Request objects and numeric sheetId values from sheets_get_spreadsheet. Grid indexes are zero-based and end indexes exclusive. Available only when SHEETS_ENABLE_WRITE=true.",
    {
      email: accountEmailSchema,
      spreadsheet_id_or_url: spreadsheetSchema,
      requests: z.array(z.record(z.unknown())).min(1),
    },
    async ({ email, spreadsheet_id_or_url, requests }) => withSheets(email, async (sheets) => {
      const result = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: parseSpreadsheetId(spreadsheet_id_or_url),
        requestBody: { requests: requests as sheets_v4.Schema$Request[] },
      });
      return { result: result.data };
    }),
  );
}
