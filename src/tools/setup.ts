import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildAuthUrl, completeAuth, isAuthorized } from "../auth.js";
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

export function registerSetupTools(server: McpServer): void {
  server.tool(
    "setup_auth",
    "Authorize the Gmail MCP. Call with no arguments to get a consent URL — visit it in your browser, pick the account, and grant access. After consent, your browser will fail to load (ERR_CONNECTION_REFUSED on localhost) — that is expected. Copy the URL from the address bar and call this tool again passing it as `url_or_code` to finish setup.",
    {
      url_or_code: z
        .string()
        .optional()
        .describe(
          "Omit to start auth and receive a consent URL. Pass the post-consent localhost URL (or just the `code` param) to complete auth.",
        ),
    },
    async ({ url_or_code }) => {
      if (url_or_code) {
        const result = await completeAuth(url_or_code);
        return asText({
          ok: true,
          authorized: true,
          scopes_granted: result.scopes,
          token_path: paths.token,
        });
      }

      const url = buildAuthUrl();
      return asText(
        [
          isAuthorized()
            ? "(Already authorized — running this will replace the existing token.)\n"
            : "",
          "1. Open this URL in a browser and grant access:",
          "",
          url,
          "",
          "2. Your browser will show ERR_CONNECTION_REFUSED on localhost — that is expected.",
          "3. Copy the FULL URL from the address bar (it contains the auth code) and call `setup_auth` again with that URL as `url_or_code`.",
        ].join("\n"),
      );
    },
  );
}
