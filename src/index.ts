#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initAuth, getClient, isAuthorized } from "./auth.js";
import { flags } from "./config.js";
import { registerSetupTools } from "./tools/setup.js";
import { registerGmailReadTools } from "./tools/gmail-read.js";
import { registerGmailDraftTools } from "./tools/gmail-drafts.js";
import { registerGmailSendTools } from "./tools/gmail-send.js";
import { registerGmailAttachmentTools } from "./tools/gmail-attachments.js";
import { registerCalendarTools } from "./tools/calendar.js";

async function main(): Promise<void> {
  await initAuth();
  const auth = getClient();

  const server = new McpServer({ name: "gmail-mcp", version: "0.1.0" });

  registerSetupTools(server);
  registerGmailReadTools(server, auth);
  registerGmailDraftTools(server, auth);
  registerGmailAttachmentTools(server, auth);
  registerCalendarTools(server, auth);
  if (flags.enableSend) {
    registerGmailSendTools(server, auth);
    console.error("[gmail-mcp] send tools ENABLED");
  } else {
    console.error("[gmail-mcp] send tools disabled (set GMAIL_ENABLE_SEND=true to enable)");
  }

  if (!isAuthorized()) {
    console.error("[gmail-mcp] no token — call setup_auth to authorize");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[gmail-mcp] fatal:", err);
  process.exit(1);
});
