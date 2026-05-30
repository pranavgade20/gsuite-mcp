import { readFile, writeFile, chmod } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { paths, SCOPES } from "./config.js";

type OAuthClientFile = {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
};

type StoredToken = {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string | null;
  expiry_date?: number | null;
};

const REDIRECT_URI = "http://localhost";

const DEFAULT_CLIENT_ID =
  "1062805821973-l8h6p6hmp7bbu0388rji04nokl5rm102.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = "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";

let client: OAuth2Client | null = null;
let authorized = false;
let pendingVerifier: string | null = null;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeTokenSecure(token: StoredToken): Promise<void> {
  await writeFile(paths.token, JSON.stringify(token, null, 2), "utf8");
  await chmod(paths.token, 0o600);
}

async function loadClientConfig(): Promise<{ clientId: string; clientSecret: string }> {
  const file = await readJson<OAuthClientFile>(paths.oauthClient);
  if (!file) {
    return { clientId: DEFAULT_CLIENT_ID, clientSecret: DEFAULT_CLIENT_SECRET };
  }
  const block = file.installed ?? file.web;
  if (!block) {
    throw new Error(`OAuth client file at ${paths.oauthClient} missing "installed" or "web" block`);
  }
  return { clientId: block.client_id, clientSecret: block.client_secret };
}

export async function initAuth(): Promise<void> {
  const { clientId, clientSecret } = await loadClientConfig();
  client = new OAuth2Client({ clientId, clientSecret, redirectUri: REDIRECT_URI });

  client.on("tokens", (next) => {
    void persistRotatedToken(next as StoredToken).catch((e) => {
      console.error("[gmail-mcp] failed to persist refreshed token:", e);
    });
  });

  const stored = await readJson<StoredToken>(paths.token);
  if (stored && (stored.access_token || stored.refresh_token)) {
    client.setCredentials(stored);
    authorized = true;
  }
}

async function persistRotatedToken(next: StoredToken): Promise<void> {
  const current = (await readJson<StoredToken>(paths.token)) ?? {};
  const merged: StoredToken = { ...current, ...next };
  if (!merged.refresh_token && current.refresh_token) {
    merged.refresh_token = current.refresh_token;
  }
  await writeTokenSecure(merged);
}

export function getClient(): OAuth2Client {
  if (!client) throw new Error("Auth not initialized");
  return client;
}

export function isAuthorized(): boolean {
  return authorized;
}

export function ensureAuthorized(): void {
  if (!authorized) {
    throw new Error(
      "Gmail MCP is not authorized yet. Call `setup_begin_auth`, visit the URL, then pass the resulting URL to `setup_complete_auth`.",
    );
  }
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildAuthUrl(): string {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  pendingVerifier = verifier;
  return getClient().generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: challenge,
  });
}

function extractCode(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const code = new URL(trimmed).searchParams.get("code");
      if (code) return code;
    } catch {}
  }
  return trimmed;
}

export async function completeAuth(input: string): Promise<{ scopes: string[] }> {
  if (!pendingVerifier) {
    throw new Error("No pending auth flow. Call `setup_begin_auth` first.");
  }
  const code = extractCode(input);
  const { tokens } = await getClient().getToken({
    code,
    codeVerifier: pendingVerifier,
  });
  pendingVerifier = null;

  if (!tokens.refresh_token) {
    console.error(
      "[gmail-mcp] warning: no refresh_token returned. Revoke prior consent at " +
        "https://myaccount.google.com/permissions and retry.",
    );
  }

  await writeTokenSecure(tokens);
  getClient().setCredentials(tokens);
  authorized = true;
  return { scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean) };
}
