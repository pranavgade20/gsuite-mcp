import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.GMAIL_MCP_CONFIG_DIR ?? join(homedir(), ".config", "gmail-mcp");

export const paths = {
  configDir: CONFIG_DIR,
  oauthClient: join(CONFIG_DIR, "oauth-client.json"),
  token: join(CONFIG_DIR, "token.json"),
};

export const flags = {
  enableSend: process.env.GMAIL_ENABLE_SEND === "true",
};

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];
