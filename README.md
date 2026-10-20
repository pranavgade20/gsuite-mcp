# gsuite-mcp

MCP server for Gmail, Google Calendar, Google Docs, Google Sheets, and Google Drive. Supports multiple Google accounts. TypeScript, local stdio or authenticated Streamable HTTP over HTTPS.

## Design

- **Writes are explicitly gated.** OAuth grants write-capable scopes, but mutating tools are only registered when their environment flags are enabled: `GMAIL_ENABLE_WRITE`, `GMAIL_ENABLE_SEND`, `CALENDAR_ENABLE_WRITE`, `DOCS_ENABLE_WRITE`, and `SHEETS_ENABLE_WRITE`. All default to disabled.
- **Proper RFC 5322 reply threading.** Pass `reply_to_message_id` to `gmail_create_draft` or `gmail_send_message` and the server fetches the source message, sets `In-Reply-To` / `References`, and reuses `threadId`.
- **Bulk-first.** `gmail_bulk_export` dumps a query result (metadata + bodies + attachments) to a directory; `gmail_bulk_modify_labels` calls `batchModify` so 1000 messages cost one API call.
- **Account-aware.** Add accounts without restarting the server. Every Gmail, Calendar, Docs, Sheets, and Drive tool accepts `email`; it is required when multiple accounts are configured and optional when there is only one.
- **Google Docs read/write.** Read complete document structures or plain text, create documents, insert/replace text, and apply advanced batch updates.
- **Google Sheets read/write.** Inspect tabs and metadata, read multiple cell ranges, create spreadsheets, write or append values, clear cells, and apply formatting or structural updates. Value writes default to `RAW`; choose `USER_ENTERED` to interpret formulas and dates.
- **Google Drive browsing.** Browse My Drive and shared-drive folders, search with Drive query syntax, inspect metadata, read text content, and download/export files. Drive access is read-only.
- **Tokens stored under `~/.config/gmail-mcp/` with `0600`.** Refresh tokens are persisted on rotation. Override with `GMAIL_MCP_CONFIG_DIR=/some/path`.
- **Remote credential isolation.** Run HTTPS on a trusted host or dedicated container. Google tokens stay there; agent containers connect to `/mcp` with a separate MCP access key. Remote clients cannot authorize accounts or write server files.

## Install

```bash
npx -y gsuite-mcp@latest
```

## Prerequisites

A Google account. That's it — the package ships with a default OAuth client, so you do not need to create your own GCP project.

### Optional: bring your own OAuth client

If you'd rather run against your own Google Cloud project (separate quota, your own consent screen):

1. Enable the Gmail API, Calendar API, Google Docs API, Google Sheets API, and Google Drive API on the project.
2. Configure the OAuth consent screen (External, Testing mode is fine — add yourself as a Test user).
3. Create an **OAuth 2.0 Client ID** of type **Desktop app** and download the credentials JSON.
4. Save it as `~/.config/gmail-mcp/oauth-client.json`. When present, this file overrides the bundled defaults.

## HTTPS: keep Google tokens outside agent containers

Run the MCP server as a separate service on a trusted host or in a dedicated container. Mount the Google configuration directory **only into that service**, with write access for refreshed tokens. Do not share its home directory, token directory, TLS private key, or container runtime socket with agents.

1. Authorize Google accounts on the trusted host using the local stdio setup below. Existing `token.json` files work unchanged. For an existing installation, the default `GMAIL_MCP_CONFIG_DIR` is still `~/.config/gmail-mcp`.
2. Generate a **separate** MCP access key once on that host:

   ```bash
   umask 077
   mkdir -p "$HOME/.config/gsuite-mcp-server"
   openssl rand -hex 32 > "$HOME/.config/gsuite-mcp-server/access-key"
   ```

3. Build this checkout with `npm ci && npm run build`, supply a TLS certificate/key for the hostname agents will use, and start the service:

   ```bash
   GSUITE_MCP_TRANSPORT=https \
   GSUITE_MCP_HOST=0.0.0.0 \
   GSUITE_MCP_PORT=8443 \
   GSUITE_MCP_TLS_CERT_FILE=/etc/gsuite-mcp/fullchain.pem \
   GSUITE_MCP_TLS_KEY_FILE=/etc/gsuite-mcp/privkey.pem \
   GSUITE_MCP_BEARER_TOKEN_FILE="$HOME/.config/gsuite-mcp-server/access-key" \
   GMAIL_MCP_CONFIG_DIR="$HOME/.config/gmail-mcp" \
   node dist/src/index.js
   ```

   The certificate must be trusted by your MCP client and valid for its connection hostname. Use your internal CA or a publicly trusted certificate; keep certificate verification enabled. Set the existing write flags on this **server process** to enable mutating tools.

4. Configure the agent's MCP client for Streamable HTTP at `https://mcp.example.com:8443/mcp`, with `Authorization: Bearer <MCP_ACCESS_KEY>`. Use the hostname in your certificate. Clients that accept JSON HTTP configuration can use:

   ```json
   {
     "mcpServers": {
       "gmail": {
         "type": "http",
         "url": "https://mcp.example.com:8443/mcp",
         "headers": {
           "Authorization": "Bearer <MCP_ACCESS_KEY>"
         }
       }
     }
   }
   ```

   Prefer the client's secret/header injection mechanism over storing the key in a repository. Replace the previous `command`/`args` stdio entry; agents no longer launch this server or receive its Google credentials.

The MCP access key grants access to every configured Google account and every enabled remote tool on this server; it is not a Google access or refresh token. If **no credentials at all** may enter agent containers, have a trusted MCP client/gateway outside them inject the Authorization header. Rotate the MCP key independently of Google tokens and restart the service after rotation. This is a shared trusted service, not per-agent account authorization.

Remote mode exposes `setup_list_accounts`, but omits `setup_auth`, `setup_add_account`, `drive_download_file`, `gmail_download_attachments`, and `gmail_bulk_export`. Arbitrary output paths on the token-owning server would allow credential or code overwrites. Use remote read tools such as `drive_read_file` for returned content. These local file tools remain available over stdio. To add or reauthorize an account, stop the remote service, use a local stdio client on the trusted host with the same config directory, then restart the service. Avoid multiple processes writing the same token registry.

### Docker on a private agent network

The `Dockerfile` serves plain HTTP with `GSUITE_MCP_ALLOW_PRIVATE_HTTP=true`, and every request still needs the bearer key. The `gsuite-mcp` service in `../browser-sandbox/docker-compose.yml` runs it on the external `mcp` network. That service mounts `~/.config/gmail-mcp` as the registry and reads its key from `~/.config/mcp-access-keys/gsuite`. Agents use `http://gsuite-mcp:8080/mcp` with `Authorization: Bearer <key>`; the host uses `http://127.0.0.1:8932/mcp`. Do not mount `~/.config/gmail-mcp` into agent containers. To add or reauthorize an account, run `docker compose stop gsuite-mcp`, use a local stdio client, then start the service again.

### HTTPS at an existing reverse proxy

For a proxy on the same host/network namespace, use `GSUITE_MCP_TRANSPORT=http` with `GSUITE_MCP_HOST=127.0.0.1` and `GSUITE_MCP_PORT=8080`, omit the TLS file settings, and keep the MCP access key configured. The HTTP backend **refuses non-loopback binds**. Publish only the proxy's HTTPS endpoint, preserving `/mcp` and the Authorization header. For example, a Caddy site can forward to the backend:

```caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

A proxy in a separate network namespace must connect to the server's direct HTTPS listener instead. HTTP mode never trusts `X-Forwarded-*` headers to bypass authentication.

### Transport settings

| Environment variable | Default / meaning |
| --- | --- |
| `GSUITE_MCP_TRANSPORT` | `stdio`; set `https` for direct TLS or `http` for a loopback proxy backend |
| `GSUITE_MCP_HOST` | `127.0.0.1`; explicitly use `0.0.0.0` for direct HTTPS across containers |
| `GSUITE_MCP_PORT` | `8443` for HTTPS, `8080` for HTTP |
| `GSUITE_MCP_TLS_CERT_FILE` | Required PEM certificate/full chain for HTTPS |
| `GSUITE_MCP_TLS_KEY_FILE` | Required PEM private key for HTTPS |
| `GSUITE_MCP_BEARER_TOKEN_FILE` | File containing the MCP access key (at least 32 characters) |
| `GSUITE_MCP_BEARER_TOKEN` | Alternative to the token file; configure exactly one source |
| `GSUITE_MCP_ALLOWED_ORIGINS` | Optional comma-separated exact HTTPS origins; requests with an Origin header are otherwise rejected |

Native MCP clients normally omit Origin. The endpoint does not enable browser CORS. Following the [MCP transport security requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), it validates any supplied Origin and authenticates every request. `/mcp` uses stateless POST requests with JSON responses, supports concurrent clients, and limits request bodies to 4 MiB. GET/DELETE return 405; no persistent sessions or legacy SSE endpoint are created.

## Register a local stdio client

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

Enable only the write surfaces you want exposed:

```json
"env": {
  "GMAIL_ENABLE_WRITE": "true",
  "GMAIL_ENABLE_SEND": "true",
  "CALENDAR_ENABLE_WRITE": "true",
  "DOCS_ENABLE_WRITE": "true",
  "SHEETS_ENABLE_WRITE": "true"
}
```

- `GMAIL_ENABLE_WRITE` — label changes and draft create/update/delete
- `GMAIL_ENABLE_SEND` — immediate message/draft sending
- `CALENDAR_ENABLE_WRITE` — event create/update/delete
- `DOCS_ENABLE_WRITE` — document create, insert/replace text, and advanced batch updates
- `SHEETS_ENABLE_WRITE` — spreadsheet creation, value writes/appends/clears, and advanced formatting or structural updates

Restart the MCP server after changing environment flags so its tool list is rebuilt.

## Authorize accounts (local stdio MCP)

On the trusted host, after the server is registered with a local stdio client:

1. Ask the model to call `setup_auth` with no arguments (or with the intended `email`). It returns a URL.
2. Open the URL in a browser, pick the account, grant access.
3. Your browser shows `ERR_CONNECTION_REFUSED` on `http://localhost/?code=...` — expected. **Copy the full URL from the address bar.**
4. Ask the model to call `setup_auth` again, passing the URL as `url_or_code`. The token is saved; Gmail, Calendar, Docs, Sheets, and Drive tools become live without restart.

PKCE is used end-to-end. No loopback server is run.

To add another account, use `setup_add_account` with the same two-call flow. Use `setup_list_accounts` to see configured emails and granted scopes. Once two or more accounts are configured, pass `email` to every Gmail, Calendar, Docs, Sheets, and Drive tool call; calls without it return the list of available accounts and an error. Email matching is case-insensitive.

Existing installations should run `setup_auth` once again for each account to grant the Google Drive read-only scope (and the Google Docs scope if it was not granted previously). The old single-account token format is migrated automatically when the server can identify its account.

### Adding Sheets to an existing installation

1. Build and restart the updated server. For a local checkout, run `npm install` and `npm run build`, and point the MCP client at `node /absolute/path/to/gsuite-mcp/dist/src/index.js`.
2. Existing `drive.readonly` grants already permit native Sheets reads. The Google Sheets API must also be enabled in the OAuth client's Google Cloud project.
3. To edit, set `SHEETS_ENABLE_WRITE=true` in the MCP server environment and restart it. Run `setup_auth` for each account you want to edit with and complete Google's consent flow to grant `https://www.googleapis.com/auth/spreadsheets`.
4. Check `setup_list_accounts` for the granted Sheets scope. A newly requested scope does not upgrade existing tokens automatically, and the account still needs edit permission on each target spreadsheet.

See Google's [read authorization scopes](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet#authorization-scopes) and [Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes).

## Tool surface

**Setup** (account authorization is local stdio only; listing is also available remotely)

- `setup_auth` — authorize the first account or reauthorize an existing account
- `setup_add_account` — authorize another account without replacing existing accounts
- `setup_list_accounts` — list account emails and granted scopes

All Gmail, Calendar, Docs, Sheets, and Drive tools below accept an `email` parameter. It may be omitted only when exactly one account is configured.

**Gmail (always on)**

- `gmail_search` — Gmail query syntax. Returns enriched metadata (`from`/`subject`/`date`/`snippet`/`labelIds`/`hasAttachments`) by default; pass `format: 'ids'` for ID-only.
- `gmail_get_message`, `gmail_get_thread`
- `gmail_list_labels`
- `gmail_list_drafts`, `gmail_get_draft`
- `gmail_download_attachments` — bulk by query, with mime/filename filters (local stdio only)
- `gmail_bulk_export` — bulk export to per-message subdirectories (metadata, body, attachments) plus a top-level `index.json` (local stdio only)

**Gmail (only when `GMAIL_ENABLE_WRITE=true`)**

- `gmail_modify_labels`, `gmail_bulk_modify_labels`
- `gmail_create_draft`, `gmail_update_draft`, `gmail_delete_draft`

**Gmail (only when `GMAIL_ENABLE_SEND=true`)**

- `gmail_send_message`, `gmail_send_draft`

**Calendar (always on)**

- `calendar_list_calendars`, `calendar_list_events`, `calendar_get_event`

**Calendar (only when `CALENDAR_ENABLE_WRITE=true`)**

- `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`

**Google Docs (always on)**

- `docs_read_document` — accept a document ID or Docs URL and return readable text per tab plus combined text
- `docs_get_document` — return the full structured Google Docs API response

**Google Docs (only when `DOCS_ENABLE_WRITE=true`)**

- `docs_create_document` — create a document with optional initial text
- `docs_insert_text` — append or insert text at a Docs API index
- `docs_replace_all_text` — replace matching text across all or selected tabs
- `docs_batch_update` — apply advanced Docs API edits and formatting requests

**Google Sheets (always on)**

- `sheets_get_spreadsheet` — accept a spreadsheet ID or URL; return metadata, tab IDs/titles, grid dimensions, named ranges, and other properties. Set `include_grid_data=true` with `ranges` to inspect cell formatting.
- `sheets_read_values` — read one or more A1 ranges across tabs; choose formatted values, calculated values, or formulas, and row or column orientation

**Google Sheets (only when `SHEETS_ENABLE_WRITE=true`)**

- `sheets_create_spreadsheet` — create a spreadsheet with optional named tabs, locale, and time zone; returns its URL and tab IDs
- `sheets_write_values` — write multiple ranges in one API call; `RAW` by default, or `USER_ENTERED` for formulas and parsed input
- `sheets_append_values` — append after the logical table found in an A1 range; inserts rows by default and returns the actual destination range
- `sheets_clear_values` — clear values in multiple ranges while preserving formatting and validation
- `sheets_batch_update` — advanced Sheets API requests for tabs, rows/columns, formatting, filters, validation, charts, and other spreadsheet changes

Find spreadsheets with `drive_search_files` and `query: "mimeType = 'application/vnd.google-apps.spreadsheet'"`. Use `sheets_get_spreadsheet` to discover tab titles and numeric IDs before reading or editing. A URL's `gid` is not used to select a tab: qualify ranges explicitly, such as `'Program budget'!A1:D20`. For tabs with apostrophes, double the apostrophe, for example `'Team''s budget'!A1:D20`.

Example `sheets_write_values` arguments:

```json
{
  "email": "you@example.com",
  "spreadsheet_id_or_url": "YOUR_SPREADSHEET_ID",
  "value_input_option": "USER_ENTERED",
  "data": [
    { "range": "'Summary'!A1:B2", "values": [["Item", "Total"], ["Budget", "=SUM('Costs'!B2:B100)"]] }
  ]
}
```

Cell values may be strings, numbers, booleans, or `null`. `null` skips a cell; `""` clears it. Reads omit trailing empty rows and columns. Advanced batch requests use Google's camelCase request fields, numeric `sheetId` values, and zero-based grid indexes with exclusive end indexes. The value write tools use A1 ranges instead.

**Google Drive (read-only)**

- `drive_list_folder` — list the direct children of My Drive root or a folder ID/URL, with pagination and optional filters
- `drive_search_files` — search files and folders with Google Drive API query syntax
- `drive_get_file` — return detailed metadata for a file, folder, or shortcut
- `drive_read_file` — return text content; exports Docs/Sheets/Slides to text or CSV by default
- `drive_download_file` — download a blob file or export a Google Workspace file to an absolute local path (local stdio only)
- `drive_list_shared_drives` — list shared drives accessible to the selected account

## Scopes

- `https://www.googleapis.com/auth/gmail.modify` (read, draft, label, send)
- `https://www.googleapis.com/auth/calendar`
- `https://www.googleapis.com/auth/documents`
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/drive.readonly`

Gmail has no scope that grants drafts without also granting send. Send is gated at the *tool* layer, not the scope layer — Google's own official MCP makes the same tradeoff.

## Config paths

- OAuth client (optional override): `~/.config/gmail-mcp/oauth-client.json`
- Account token registry: `~/.config/gmail-mcp/token.json`

Override with `GMAIL_MCP_CONFIG_DIR=/some/path`.

## License

MIT
