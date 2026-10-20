import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { flags } from "./config.js";
import { registerSetupTools } from "./tools/setup.js";
import { registerGmailReadTools } from "./tools/gmail-read.js";
import { registerGmailDraftTools } from "./tools/gmail-drafts.js";
import { registerGmailSendTools } from "./tools/gmail-send.js";
import { registerGmailAttachmentTools } from "./tools/gmail-attachments.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerDriveTools } from "./tools/drive.js";
import { registerSheetsTools } from "./tools/sheets.js";

// Each HTTP request owns its MCP server/transport. Google clients and token
// persistence stay in auth.ts and are shared only within this trusted process.
export function createMcpServer({ remote = false } = {}): McpServer {
  const server = new McpServer({ name: "gsuite-mcp", version: "0.4.0" });
  registerSetupTools(server, !remote);
  registerGmailReadTools(server, flags.enableGmailWrite);
  registerGmailDraftTools(server, flags.enableGmailWrite);
  registerGmailAttachmentTools(server, flags.enableGmailWrite, !remote);
  registerCalendarTools(server, flags.enableCalendarWrite);
  registerDocsTools(server, flags.enableDocsWrite);
  registerDriveTools(server, !remote);
  registerSheetsTools(server, flags.enableSheetsWrite);
  if (flags.enableSend) registerGmailSendTools(server);
  return server;
}
