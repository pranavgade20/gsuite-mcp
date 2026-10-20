#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initAuth, isAuthorized } from "./auth.js";
import { flags, loadTransportConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { createNetworkServer } from "./network.js";

async function main(): Promise<void> {
  const config = await loadTransportConfig();
  await initAuth();
  console.error("[gmail-mcp] Drive read-only tools ENABLED");
  console.error(
    `[gmail-mcp] Gmail write tools ${flags.enableGmailWrite ? "ENABLED" : "disabled"} ` +
      "(set GMAIL_ENABLE_WRITE=true to enable)",
  );
  console.error(
    `[gmail-mcp] Calendar write tools ${flags.enableCalendarWrite ? "ENABLED" : "disabled"} ` +
      "(set CALENDAR_ENABLE_WRITE=true to enable)",
  );
  console.error(
    `[gmail-mcp] Docs write tools ${flags.enableDocsWrite ? "ENABLED" : "disabled"} ` +
      "(set DOCS_ENABLE_WRITE=true to enable)",
  );
  console.error(
    `[gmail-mcp] Sheets write tools ${flags.enableSheetsWrite ? "ENABLED" : "disabled"} ` +
      "(set SHEETS_ENABLE_WRITE=true to enable)",
  );
  if (flags.enableSend) {
    console.error("[gmail-mcp] send tools ENABLED");
  } else {
    console.error("[gmail-mcp] send tools disabled (set GMAIL_ENABLE_SEND=true to enable)");
  }

  if (!isAuthorized()) {
    console.error("[gsuite-mcp] no Google accounts — authorize using setup_auth in local stdio mode");
  }

  if (config.transport === "stdio") {
    await createMcpServer().connect(new StdioServerTransport());
    return;
  }

  const server = await createNetworkServer(config);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const hostname = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.error(`[gsuite-mcp] listening on ${config.transport}://${hostname}:${config.port}/mcp`);
  console.error("[gsuite-mcp] remote mode: account authorization and server-file tools disabled");
  const shutdown = () => {
    const deadline = setTimeout(() => { server.closeAllConnections(); }, 10_000);
    deadline.unref();
    server.close(() => { clearTimeout(deadline); });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[gmail-mcp] fatal:", err);
  process.exit(1);
});
