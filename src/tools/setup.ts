import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildAuthUrl, completeAuth, isAuthorized, listAccounts } from "../auth.js";
import { paths } from "../config.js";

function asText(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function registerSetupTools(server: McpServer, allowAuthorization = true): void {
  const authSchema = {
    email: z
      .string()
      .email()
      .optional()
      .describe("Optional account to preselect and verify during authorization."),
    url_or_code: z
      .string()
      .optional()
      .describe(
        "Omit to start auth and receive a consent URL. Pass the post-consent localhost URL (or just the `code` param) to complete auth.",
      ),
  };

  const authHandler = async ({ email, url_or_code }: { email?: string; url_or_code?: string }) => {
    if (url_or_code) {
      const result = await completeAuth(url_or_code);
      const configured = listAccounts();
      return asText({
        ok: true,
        authorized: true,
        account_email: result.email,
        replaced_existing_account: result.replaced,
        scopes_granted: result.scopes,
        configured_accounts: configured.map((account) => account.email),
        email_required_for_google_tools: configured.length > 1,
        token_path: paths.token,
      });
    }

    const url = buildAuthUrl(email);
    return asText(
      [
        isAuthorized()
          ? "(One or more accounts are already authorized; completing this flow will add or replace the selected account.)\n"
          : "",
        "1. Open this URL in a browser and grant access:",
        "",
        url,
        "",
        "2. Your browser will show ERR_CONNECTION_REFUSED on localhost — that is expected.",
        "3. Copy the FULL URL from the address bar (it contains the auth code) and call this tool again with that URL as `url_or_code`.",
      ].join("\n"),
    );
  };

  if (allowAuthorization) server.tool(
    "setup_auth",
    "Authorize the first Google account or reauthorize an existing one. Call without `url_or_code` to begin, then call again with the post-consent localhost URL/code to finish. Requests Gmail, Calendar, read/write Google Docs and Sheets, and read-only Google Drive access. Existing accounts must reauthorize to grant newly added scopes.",
    authSchema,
    authHandler,
  );

  if (allowAuthorization) server.tool(
    "setup_add_account",
    "Authorize an additional Google account. Call without `url_or_code` to get a consent URL, then call again with the post-consent localhost URL/code. Once multiple accounts are configured, Google tools require `email` on every call.",
    authSchema,
    authHandler,
  );

  server.tool(
    "setup_list_accounts",
    "List configured Google accounts and their granted OAuth scopes.",
    {},
    async () => {
      const accounts = listAccounts();
      return asText({
        accounts,
        count: accounts.length,
        email_required_for_google_tools: accounts.length > 1,
      });
    },
  );
}
