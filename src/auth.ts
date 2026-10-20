import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { google } from "googleapis";
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

type StoredAccountsFile = {
  version: 2;
  accounts: Record<string, StoredToken>;
  legacyToken?: StoredToken;
};

export type AuthorizedAccount = {
  email: string;
  client: OAuth2Client;
};

type AccountRecord = AuthorizedAccount & {
  token: StoredToken;
};

type PendingAuth = {
  client: OAuth2Client;
  verifier: string;
  expectedEmail?: string;
};

const REDIRECT_URI = "http://localhost";

const DEFAULT_CLIENT_ID =
  "1062805821973-l8h6p6hmp7bbu0388rji04nokl5rm102.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = "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";

let oauthClientConfig: { clientId: string; clientSecret: string } | null = null;
const accounts = new Map<string, AccountRecord>();
let legacyAccount: AccountRecord | null = null;
let pendingAuth: PendingAuth | null = null;
let persistenceQueue: Promise<void> = Promise.resolve();

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeAccountsSecure(): Promise<void> {
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  const stored: StoredAccountsFile = { version: 2, accounts: {} };
  for (const account of accounts.values()) {
    stored.accounts[account.email] = account.token;
  }
  if (legacyAccount) stored.legacyToken = legacyAccount.token;
  const temporaryPath = `${paths.token}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(stored, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, paths.token);
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function createOAuthClient(): OAuth2Client {
  if (!oauthClientConfig) throw new Error("Auth not initialized");
  return new OAuth2Client({ ...oauthClientConfig, redirectUri: REDIRECT_URI });
}

function mergeTokens(current: StoredToken, next: StoredToken): StoredToken {
  const merged = { ...current, ...next };
  if (!next.refresh_token && current.refresh_token) merged.refresh_token = current.refresh_token;
  return merged;
}

function persistAccounts(): Promise<void> {
  persistenceQueue = persistenceQueue.catch(() => undefined).then(() => writeAccountsSecure());
  return persistenceQueue;
}

function attachTokenPersistence(account: AccountRecord): void {
  account.client.on("tokens", (next) => {
    account.token = mergeTokens(account.token, next as StoredToken);
    void persistAccounts().catch((error) => {
      console.error(`[gmail-mcp] failed to persist refreshed token for ${account.email}:`, error);
    });
  });
}

function addStoredAccount(email: string, token: StoredToken, client?: OAuth2Client): AccountRecord {
  const normalized = normalizeEmail(email);
  const account: AccountRecord = {
    email: normalized,
    client: client ?? createOAuthClient(),
    token,
  };
  account.client.setCredentials(token);
  attachTokenPersistence(account);
  accounts.set(normalized, account);
  return account;
}

function isStoredAccountsFile(value: unknown): value is StoredAccountsFile {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredAccountsFile>;
  return candidate.version === 2 && !!candidate.accounts && typeof candidate.accounts === "object";
}

async function identifyEmail(client: OAuth2Client): Promise<string> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const profile = await gmail.users.getProfile({ userId: "me" });
  if (!profile.data.emailAddress) {
    throw new Error("Google did not return an email address for the authorized account");
  }
  return normalizeEmail(profile.data.emailAddress);
}

async function migrateLegacyToken(token: StoredToken): Promise<void> {
  const client = createOAuthClient();
  client.setCredentials(token);
  try {
    const email = await identifyEmail(client);
    const merged = mergeTokens(token, client.credentials as StoredToken);
    addStoredAccount(email, merged, client);
    await persistAccounts();
    console.error(`[gmail-mcp] migrated legacy token for ${email} to multi-account storage`);
  } catch (error) {
    legacyAccount = { email: "legacy-account", client, token };
    console.error(
      "[gmail-mcp] could not identify the account in the legacy token; it remains available " +
        "for calls without `email`. Reauthorize it with setup_auth to finish migration:",
      error,
    );
  }
}

export async function initAuth(): Promise<void> {
  oauthClientConfig = await loadClientConfig();

  const stored = await readJson<StoredAccountsFile | StoredToken>(paths.token);
  if (isStoredAccountsFile(stored)) {
    for (const [email, token] of Object.entries(stored.accounts)) {
      if (token.access_token || token.refresh_token) addStoredAccount(email, token);
    }
    if (stored.legacyToken?.access_token || stored.legacyToken?.refresh_token) {
      const client = createOAuthClient();
      client.setCredentials(stored.legacyToken);
      legacyAccount = { email: "legacy-account", client, token: stored.legacyToken };
    }
  } else if (stored && (stored.access_token || stored.refresh_token)) {
    await migrateLegacyToken(stored);
  }
}

export function listAccounts(): Array<{ email: string; scopes: string[] }> {
  const configured = [...accounts.values()].map((account) => ({
    email: account.email,
    scopes: (account.token.scope ?? "").split(/\s+/).filter(Boolean),
  }));
  if (legacyAccount) configured.push({ email: legacyAccount.email, scopes: [] });
  return configured.sort((a, b) => a.email.localeCompare(b.email));
}

export function getAccount(email?: string): AuthorizedAccount {
  if (email) {
    const normalized = normalizeEmail(email);
    const account = accounts.get(normalized);
    if (account) return account;
    const available = [...accounts.keys()].sort();
    throw new Error(
      `Account ${email} is not configured. Available accounts: ${available.join(", ") || "none"}. ` +
        "Call `setup_add_account` to authorize it.",
    );
  }

  if (accounts.size === 1 && !legacyAccount) return accounts.values().next().value!;
  if (accounts.size === 0 && legacyAccount) return legacyAccount;
  if (accounts.size === 0) {
    throw new Error("No Google account is configured. Call `setup_auth` to authorize one.");
  }
  throw new Error(
    "The `email` parameter is required because multiple accounts are configured. Available accounts: " +
      [...accounts.keys()].sort().join(", "),
  );
}

export function isAuthorized(): boolean {
  return accounts.size > 0 || legacyAccount !== null;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildAuthUrl(email?: string): string {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const client = createOAuthClient();
  pendingAuth = {
    client,
    verifier,
    expectedEmail: email ? normalizeEmail(email) : undefined,
  };
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent select_account",
    include_granted_scopes: true,
    login_hint: email,
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

export async function completeAuth(
  input: string,
): Promise<{ email: string; scopes: string[]; replaced: boolean }> {
  if (!pendingAuth) {
    throw new Error("No pending auth flow. Call `setup_auth` or `setup_add_account` first.");
  }
  const flow = pendingAuth;
  const code = extractCode(input);
  const { tokens } = await flow.client.getToken({
    code,
    codeVerifier: flow.verifier,
  });
  flow.client.setCredentials(tokens);
  const email = await identifyEmail(flow.client);
  pendingAuth = null;

  if (flow.expectedEmail && email !== flow.expectedEmail) {
    throw new Error(
      `Authorized ${email}, but ${flow.expectedEmail} was requested. Start the setup flow again and choose the requested account.`,
    );
  }

  if (!tokens.refresh_token) {
    console.error(
      "[gmail-mcp] warning: no refresh_token returned. Revoke prior consent at " +
        "https://myaccount.google.com/permissions and retry.",
    );
  }

  if (legacyAccount) {
    try {
      const legacyEmail = await identifyEmail(legacyAccount.client);
      const legacyToken = mergeTokens(
        legacyAccount.token,
        legacyAccount.client.credentials as StoredToken,
      );
      legacyAccount = null;
      addStoredAccount(legacyEmail, legacyToken);
    } catch {
      // Preserve an unidentifiable legacy token until it can be reauthorized.
    }
  }

  const existing = accounts.get(email);
  const merged = mergeTokens(existing?.token ?? {}, {
    ...tokens,
    ...(flow.client.credentials as StoredToken),
  });
  addStoredAccount(email, merged, flow.client);
  await persistAccounts();
  return {
    email,
    scopes: (merged.scope ?? "").split(/\s+/).filter(Boolean),
    replaced: existing !== undefined,
  };
}
