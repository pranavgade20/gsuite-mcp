import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Use isolated fake accounts; no test can refresh real credentials or call Google.
const configDir = await mkdtemp(join(tmpdir(), "gsuite-mcp-sheets-"));
process.env.GMAIL_MCP_CONFIG_DIR = configDir;
await writeFile(join(configDir, "token.json"), JSON.stringify({
  version: 2,
  accounts: {
    "first@example.com": { access_token: "fake-first", scope: "https://www.googleapis.com/auth/drive.readonly" },
    "second@example.com": { access_token: "fake-second", scope: "https://www.googleapis.com/auth/spreadsheets" },
  },
}));
const { initAuth, getAccount, buildAuthUrl } = await import("../src/auth.js");
const { parseSpreadsheetId, registerSheetsTools } = await import("../src/tools/sheets.js");
await initAuth();
after(() => rm(configDir, { recursive: true, force: true }));

const calls: Array<{ email: string; url: string; method: string; params: any; data: any }> = [];
let response: unknown;
let apiError: unknown;
for (const email of ["first@example.com", "second@example.com"]) {
  getAccount(email).client.request = (async (options: any) => {
    calls.push({ email, url: String(options.url), method: options.method, params: options.params, data: options.data });
    if (apiError) throw apiError;
    return { data: response };
  }) as any;
}

async function withClient(action: (client: Client) => Promise<void>, enableWrite = true) {
  calls.length = 0;
  response = {};
  apiError = undefined;
  const server = new McpServer({ name: "sheets-test", version: "1.0.0" });
  registerSheetsTools(server, enableWrite);
  const client = new Client({ name: "sheets-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const target = { email: "second@example.com", spreadsheet_id_or_url: "https://docs.google.com/spreadsheets/d/book_123/edit#gid=42" };
function output(result: any) {
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test("IDs and URLs select a spreadsheet without accepting published links or another host", () => {
  assert.equal(parseSpreadsheetId(" book_123-Z "), "book_123-Z");
  assert.equal(parseSpreadsheetId(target.spreadsheet_id_or_url), "book_123");
  assert.equal(parseSpreadsheetId("https://docs.google.com/spreadsheets/u/2/d/book_123/copy"), "book_123");
  for (const value of ["", "not a url", "https://other.example/spreadsheets/d/book/edit", "https://docs.google.com/spreadsheets/d/e/published/pubhtml"]) {
    assert.throws(() => parseSpreadsheetId(value), /spreadsheet ID/);
  }
  const url = new URL(buildAuthUrl("first@example.com"));
  assert.ok(url.searchParams.get("scope")?.split(" ").includes("https://www.googleapis.com/auth/spreadsheets"));
});

test("reads use the selected account, preserve multiple ranges and formula mode, and omit grid data by default", async () => {
  await withClient(async (client) => {
    const ranges = ["'First tab'!A1:B2", "'Second tab'!C1:C3"];
    response = { spreadsheetId: "book_123", valueRanges: [{ range: ranges[0], values: [["=SUM(A2:A3)"]] }, { range: ranges[1] }] };
    const read = output(await client.callTool({ name: "sheets_read_values", arguments: {
      ...target, email: "FIRST@EXAMPLE.COM", ranges, value_render_option: "FORMULA", major_dimension: "COLUMNS",
      date_time_render_option: "FORMATTED_STRING",
    } }));
    assert.equal(read.account_email, "first@example.com");
    assert.equal(read.value_ranges[0].values[0][0], "=SUM(A2:A3)");
    assert.equal(read.value_ranges.length, 2);
    assert.equal(calls[0].email, "first@example.com");
    assert.ok(calls[0].url.endsWith("/spreadsheets/book_123/values:batchGet"));
    assert.deepEqual(calls[0].params.ranges, ranges);
    assert.equal(calls[0].params.valueRenderOption, "FORMULA");
    assert.equal(calls[0].params.majorDimension, "COLUMNS");
    assert.equal(calls[0].params.dateTimeRenderOption, "FORMATTED_STRING");

    response = { spreadsheetId: "book_123", sheets: [{ properties: { sheetId: 42, title: "Second tab" } }] };
    const metadata = output(await client.callTool({ name: "sheets_get_spreadsheet", arguments: target }));
    assert.equal(metadata.spreadsheet.sheets[0].properties.sheetId, 42);
    assert.equal(calls[1].params.includeGridData, false);
    output(await client.callTool({ name: "sheets_get_spreadsheet", arguments: { ...target, include_grid_data: true, ranges } }));
    assert.equal(calls[2].params.includeGridData, true);
    assert.deepEqual(calls[2].params.ranges, ranges);
  }, false);
});

test("writes preserve literal formulas, null skips, empty strings, numbers and booleans; formula parsing is explicit", async () => {
  await withClient(async (client) => {
    const values = [["=SUM(A1:A2)", null, "", 0, false]];
    response = { totalUpdatedCells: 4, responses: [{ updatedRange: "Sheet1!A1:E1" }] };
    const result = output(await client.callTool({ name: "sheets_write_values", arguments: {
      ...target, data: [{ range: "Sheet1!A1:E1", values }],
    } }));
    assert.equal(result.result.totalUpdatedCells, 4);
    assert.equal(calls[0].method, "POST");
    assert.ok(calls[0].url.endsWith("/values:batchUpdate"));
    assert.equal(calls[0].data.valueInputOption, "RAW");
    assert.deepEqual(calls[0].data.data[0].values, values);
    output(await client.callTool({ name: "sheets_write_values", arguments: {
      ...target, data: [{ range: "Sheet1!A1", values: [["=1+2"]], major_dimension: "COLUMNS" }],
      value_input_option: "USER_ENTERED", include_values_in_response: true,
    } }));
    assert.equal(calls[1].data.valueInputOption, "USER_ENTERED");
    assert.equal(calls[1].data.data[0].majorDimension, "COLUMNS");
    assert.equal(calls[1].data.includeValuesInResponse, true);
  });
});

test("append inserts rows by default and returns Google's actual updated range; clear sends only ranges", async () => {
  await withClient(async (client) => {
    const range = "'Team''s tab'!A:D";
    response = { tableRange: "'Team''s tab'!A1:D4", updates: { updatedRange: "'Team''s tab'!A5:B5" } };
    const result = output(await client.callTool({ name: "sheets_append_values", arguments: { ...target, range, values: [["Ada", 7]] } }));
    assert.equal(result.result.updates.updatedRange, "'Team''s tab'!A5:B5");
    assert.ok(decodeURIComponent(calls[0].url).endsWith(`/values/${range}:append`));
    assert.equal(calls[0].params.insertDataOption, "INSERT_ROWS");
    assert.equal(calls[0].params.valueInputOption, "RAW");
    assert.deepEqual(calls[0].data.values, [["Ada", 7]]);
    output(await client.callTool({ name: "sheets_clear_values", arguments: { ...target, ranges: [range] } }));
    assert.ok(calls[1].url.endsWith("/values:batchClear"));
    assert.deepEqual(calls[1].data, { ranges: [range] });
  });
});

test("create returns tab IDs and URL; advanced updates preserve sheet ID zero and request order", async () => {
  await withClient(async (client) => {
    response = { spreadsheetId: "created", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/created/edit", sheets: [{ properties: { sheetId: 0 } }] };
    const created = output(await client.callTool({ name: "sheets_create_spreadsheet", arguments: {
      email: target.email, title: "Planning", sheet_titles: ["Tasks", "Summary"], locale: "en_GB", time_zone: "Europe/London",
    } }));
    assert.equal(created.spreadsheet.sheets[0].properties.sheetId, 0);
    assert.ok(created.spreadsheet.spreadsheetUrl.includes("/created/"));
    assert.deepEqual(calls[0].data.properties, { title: "Planning", locale: "en_GB", timeZone: "Europe/London" });
    assert.deepEqual(calls[0].data.sheets.map((sheet: any) => sheet.properties.title), ["Tasks", "Summary"]);
    const requests = [
      { updateSheetProperties: { properties: { sheetId: 0, title: "Renamed" }, fields: "title" } },
      { addSheet: { properties: { title: "New" } } },
    ];
    output(await client.callTool({ name: "sheets_batch_update", arguments: { ...target, requests } }));
    assert.deepEqual(calls[1].data.requests, requests);
    assert.ok(calls[1].url.endsWith("/spreadsheets/book_123:batchUpdate"));
  });
});

test("ambiguous accounts, invalid inputs, and disabled writes never reach Google", async () => {
  await withClient(async (client) => {
    for (const args of [
      { spreadsheet_id_or_url: "book", ranges: ["A1"] },
      { ...target, ranges: [] },
      { ...target, ranges: ["   "] },
      { ...target, ranges: ["A1"], value_render_option: "INVALID" },
    ]) {
      const result = await client.callTool({ name: "sheets_read_values", arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal((await client.callTool({ name: "sheets_write_values", arguments: { ...target, data: [{ range: "A1", values: [[{}]] }] } })).isError, true);
    assert.equal(calls.length, 0);
  });
  await withClient(async (client) => {
    const result = await client.callTool({ name: "sheets_clear_values", arguments: { ...target, ranges: ["A1"] } });
    assert.equal(result.isError, true);
    assert.equal(calls.length, 0);
  }, false);
});

test("scope and disabled API errors give actionable setup steps; ordinary access errors remain intact", async () => {
  await withClient(async (client) => {
    for (const [reason, message] of [
      ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", /setup_auth.*second@example.com|second@example.com.*setup_auth/],
      ["SERVICE_DISABLED", /Enable the Google Sheets API/],
    ] as const) {
      apiError = { response: { data: { error: { details: [{ reason }] } } } };
      const result = await client.callTool({ name: "sheets_get_spreadsheet", arguments: target });
      assert.equal(result.isError, true);
      assert.match((result.content as any)[0].text, message);
    }
    apiError = new Error("The caller does not have permission");
    const result = await client.callTool({ name: "sheets_get_spreadsheet", arguments: target });
    assert.match((result.content as any)[0].text, /The caller does not have permission/);
  });
});
