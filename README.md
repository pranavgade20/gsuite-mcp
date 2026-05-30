# gsuite-mcp

MCP server for Gmail + Google Calendar. TypeScript, stdio transport.

## Design

- **Send is gated.** Send tools (`gmail_send_message`, `gmail_send_draft`) are only registered when `GMAIL_ENABLE_SEND=true`. By default the server can search, read, label, draft, export, and modify labels in bulk — but cannot send.
- **Proper RFC 5322 reply threading.** Pass `reply_to_message_id` to `gmail_create_draft` or `gmail_send_message` and the server fetches the source message, sets `In-Reply-To` / `References`, and reuses `threadId`.
- **Bulk-first.** `gmail_bulk_export` dumps a query result (metadata + bodies + attachments) to a directory; `gmail_bulk_modify_labels` calls `batchModify` so 1000 messages cost one API call.
- **Tokens stored under `~/.config/gmail-mcp/` with `0600`.** Refresh tokens are persisted on rotation. Override with `GMAIL_MCP_CONFIG_DIR=/some/path`.

## Install

```bash
npx -y gsuite-mcp@latest
```

## Prerequisites

A Google account. That's it — the package ships with a default OAuth client, so you do not need to create your own GCP project.

### Optional: bring your own OAuth client

If you'd rather run against your own Google Cloud project (separate quota, your own consent screen):

1. Enable the Gmail API and Calendar API on the project.
2. Configure the OAuth consent screen (External, Testing mode is fine — add yourself as a Test user).
3. Create an **OAuth 2.0 Client ID** of type **Desktop app** and download the credentials JSON.
4. Save it as `~/.config/gmail-mcp/oauth-client.json`. When present, this file overrides the bundled defaults.

## Register with your MCP client

For Claude Code, add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["-y", "gsuite-mcp@latest"],
      "env": {}
    }
  }
}
```

To enable sending: `"env": { "GMAIL_ENABLE_SEND": "true" }`.

## Authorize (one-time, in-MCP)

After the server is registered:

1. Ask the model to call `setup_auth` with no arguments. It returns a URL.
2. Open the URL in a browser, pick the account, grant access.
3. Your browser shows `ERR_CONNECTION_REFUSED` on `http://localhost/?code=...` — expected. **Copy the full URL from the address bar.**
4. Ask the model to call `setup_auth` again, passing the URL as `url_or_code`. Token is saved; Gmail/Calendar tools become live without restart.

PKCE is used end-to-end. No loopback server is run.

## Tool surface

**Setup**
- `setup_auth` — call with no args for a consent URL; call again with the post-consent URL/code to finish

**Gmail (always on)**
- `gmail_search` — Gmail query syntax. Returns enriched metadata (`from`/`subject`/`date`/`snippet`/`labelIds`/`hasAttachments`) by default; pass `format: 'ids'` for ID-only.
- `gmail_get_message`, `gmail_get_thread`
- `gmail_list_labels`, `gmail_modify_labels`, `gmail_bulk_modify_labels`
- `gmail_list_drafts`, `gmail_get_draft`, `gmail_create_draft`, `gmail_update_draft`, `gmail_delete_draft`
- `gmail_download_attachments` — bulk by query, with mime/filename filters
- `gmail_bulk_export` — bulk export to per-message subdirectories (metadata, body, attachments) plus a top-level `index.json`

**Gmail (only when `GMAIL_ENABLE_SEND=true`)**
- `gmail_send_message`, `gmail_send_draft`

**Calendar (always on)**
- `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`
- `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`

## Scopes

- `https://www.googleapis.com/auth/gmail.modify` (read, draft, label, send)
- `https://www.googleapis.com/auth/calendar`

Gmail has no scope that grants drafts without also granting send. Send is gated at the *tool* layer, not the scope layer — Google's own official MCP makes the same tradeoff.

## Config paths

- OAuth client (optional override): `~/.config/gmail-mcp/oauth-client.json`
- Token: `~/.config/gmail-mcp/token.json`

Override with `GMAIL_MCP_CONFIG_DIR=/some/path`.

## License

MIT
