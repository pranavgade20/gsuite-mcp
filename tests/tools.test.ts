import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCalendarTools } from "../src/tools/calendar.js";
import { registerDocsTools } from "../src/tools/docs.js";
import { registerDriveTools } from "../src/tools/drive.js";
import { registerGmailAttachmentTools } from "../src/tools/gmail-attachments.js";
import { registerGmailDraftTools } from "../src/tools/gmail-drafts.js";
import { registerGmailReadTools } from "../src/tools/gmail-read.js";
import { registerGmailSendTools } from "../src/tools/gmail-send.js";
import { registerSetupTools } from "../src/tools/setup.js";
import { registerSheetsTools } from "../src/tools/sheets.js";
import { flags } from "../src/config.js";
import { createMcpServer } from "../src/server.js";

test("all Google service tools expose account selection", async () => {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerSetupTools(server);
  registerGmailReadTools(server, true);
  registerGmailDraftTools(server, true);
  registerGmailAttachmentTools(server, true);
  registerGmailSendTools(server);
  registerCalendarTools(server, true);
  registerDocsTools(server, true);
  registerDriveTools(server);
  registerSheetsTools(server, true);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);
    assert.ok(names.includes("setup_add_account"));
    assert.ok(names.includes("setup_list_accounts"));
    assert.ok(names.includes("docs_get_document"));
    assert.ok(names.includes("docs_read_document"));
    assert.ok(names.includes("docs_create_document"));
    assert.ok(names.includes("docs_insert_text"));
    assert.ok(names.includes("docs_replace_all_text"));
    assert.ok(names.includes("docs_batch_update"));
    assert.ok(names.includes("drive_list_folder"));
    assert.ok(names.includes("drive_search_files"));
    assert.ok(names.includes("drive_get_file"));
    assert.ok(names.includes("drive_read_file"));
    assert.ok(names.includes("drive_download_file"));
    assert.ok(names.includes("drive_list_shared_drives"));
    for (const name of [
      "sheets_get_spreadsheet", "sheets_read_values", "sheets_create_spreadsheet",
      "sheets_write_values", "sheets_append_values", "sheets_clear_values", "sheets_batch_update",
    ]) assert.ok(names.includes(name), `${name} should be registered`);

    const serviceTools = result.tools.filter((tool) => !tool.name.startsWith("setup_"));
    assert.ok(serviceTools.length > 0);
    for (const tool of serviceTools) {
      assert.ok(
        tool.inputSchema.properties?.email,
        `${tool.name} must expose the email account parameter`,
      );
    }
  } finally {
    await client.close();
  }
});

test("mutating tools are absent when write flags are disabled", async () => {
  const server = new McpServer({ name: "read-only-server", version: "1.0.0" });
  registerGmailReadTools(server);
  registerGmailDraftTools(server);
  registerGmailAttachmentTools(server);
  registerCalendarTools(server);
  registerDocsTools(server);
  registerDriveTools(server);
  registerSheetsTools(server);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const readTool of [
      "gmail_get_message",
      "gmail_get_draft",
      "calendar_get_event",
      "docs_read_document",
      "drive_list_folder",
      "sheets_get_spreadsheet",
      "sheets_read_values",
    ]) {
      assert.ok(names.includes(readTool), `${readTool} should remain available`);
    }
    for (const writeTool of [
      "gmail_modify_labels",
      "gmail_create_draft",
      "gmail_bulk_modify_labels",
      "calendar_create_event",
      "docs_create_document",
      "docs_batch_update",
      "sheets_create_spreadsheet",
      "sheets_write_values",
      "sheets_append_values",
      "sheets_clear_values",
      "sheets_batch_update",
    ]) {
      assert.ok(!names.includes(writeTool), `${writeTool} should require its write flag`);
    }
  } finally {
    await client.close();
  }
});

test("remote isolation remains enforced when all Google write flags are enabled", async () => {
  const previous = { ...flags };
  Object.assign(flags, {
    enableSend: true, enableGmailWrite: true, enableCalendarWrite: true,
    enableDocsWrite: true, enableSheetsWrite: true,
  });
  const server = createMcpServer({ remote: true });
  Object.assign(flags, previous);
  const client = new Client({ name: "remote-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["gmail_bulk_modify_labels", "gmail_create_draft", "gmail_send_message", "calendar_create_event", "docs_create_document", "sheets_write_values"]) {
      assert.ok(names.includes(name), `${name} should retain its write flag`);
    }
    for (const name of ["setup_auth", "setup_add_account", "drive_download_file", "gmail_download_attachments", "gmail_bulk_export"]) {
      assert.ok(!names.includes(name), `${name} must remain local only`);
    }
  } finally {
    await client.close();
  }
});
