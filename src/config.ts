import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const CONFIG_DIR = process.env.GMAIL_MCP_CONFIG_DIR ?? join(homedir(), ".config", "gmail-mcp");

export const paths = {
  configDir: CONFIG_DIR,
  oauthClient: join(CONFIG_DIR, "oauth-client.json"),
  token: join(CONFIG_DIR, "token.json"),
};

export const flags = {
  enableSend: process.env.GMAIL_ENABLE_SEND === "true",
  enableGmailWrite: process.env.GMAIL_ENABLE_WRITE === "true",
  enableCalendarWrite: process.env.CALENDAR_ENABLE_WRITE === "true",
  enableDocsWrite: process.env.DOCS_ENABLE_WRITE === "true",
  enableSheetsWrite: process.env.SHEETS_ENABLE_WRITE === "true",
};

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
];

export type NetworkConfig = {
  transport: "https" | "http";
  host: string;
  port: number;
  bearerToken: string;
  allowedOrigins: string[];
  tlsCertFile?: string;
  tlsKeyFile?: string;
};

export async function loadTransportConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ transport: "stdio" } | NetworkConfig> {
  const transport = env.GSUITE_MCP_TRANSPORT ?? "stdio";
  if (transport === "stdio") return { transport };
  if (transport !== "https" && transport !== "http") {
    throw new Error("GSUITE_MCP_TRANSPORT must be stdio, https, or http");
  }

  const host = env.GSUITE_MCP_HOST ?? "127.0.0.1";
  if (!host.trim()) throw new Error("GSUITE_MCP_HOST must not be empty");
  // GSUITE_MCP_ALLOW_PRIVATE_HTTP is for a container on a private Docker network
  // whose only peers are trusted agent containers; requests still need the bearer token.
  if (transport === "http" && host !== "127.0.0.1" && host !== "::1" && env.GSUITE_MCP_ALLOW_PRIVATE_HTTP !== "true") {
    throw new Error(
      "HTTP is only allowed on 127.0.0.1 or ::1 behind a local HTTPS reverse proxy " +
        "(set GSUITE_MCP_ALLOW_PRIVATE_HTTP=true inside a private Docker network)",
    );
  }
  const portText = env.GSUITE_MCP_PORT ?? (transport === "https" ? "8443" : "8080");
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("GSUITE_MCP_PORT must be an integer between 1 and 65535");
  }

  if (env.GSUITE_MCP_BEARER_TOKEN !== undefined && env.GSUITE_MCP_BEARER_TOKEN_FILE !== undefined) {
    throw new Error("Set only one of GSUITE_MCP_BEARER_TOKEN and GSUITE_MCP_BEARER_TOKEN_FILE");
  }
  const bearerToken = env.GSUITE_MCP_BEARER_TOKEN_FILE
    ? (await readFile(env.GSUITE_MCP_BEARER_TOKEN_FILE, "utf8")).trim()
    : env.GSUITE_MCP_BEARER_TOKEN ?? "";
  if (bearerToken.length < 32 || !/^[A-Za-z0-9._~+/-]+=*$/.test(bearerToken)) {
    throw new Error("HTTPS/HTTP requires a separate MCP bearer token of at least 32 characters (use openssl rand -hex 32)");
  }

  const tlsCertFile = env.GSUITE_MCP_TLS_CERT_FILE;
  const tlsKeyFile = env.GSUITE_MCP_TLS_KEY_FILE;
  if (transport === "https" && (!tlsCertFile || !tlsKeyFile)) {
    throw new Error("HTTPS requires GSUITE_MCP_TLS_CERT_FILE and GSUITE_MCP_TLS_KEY_FILE");
  }
  const allowedOrigins = (env.GSUITE_MCP_ALLOWED_ORIGINS ?? "")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    let valid = false;
    try {
      const url = new URL(origin);
      valid = url.protocol === "https:" && url.origin === origin;
    } catch { /* Report the setting name without logging its contents. */ }
    if (!valid) throw new Error("GSUITE_MCP_ALLOWED_ORIGINS must contain exact HTTPS origins, without paths or wildcards");
  }
  return { transport, host, port, bearerToken, allowedOrigins, tlsCertFile, tlsKeyFile };
}
