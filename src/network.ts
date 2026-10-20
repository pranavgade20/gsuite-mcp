import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NetworkConfig } from "./config.js";
import { createMcpServer } from "./server.js";

export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

function reply(res: ServerResponse, status: number, message: string): void {
  if (status === 413) res.setHeader("Connection", "close");
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

// Drain oversized bodies without retaining them, so the 413 response can reach
// the client instead of destroying the socket during an async-iterator break.
function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        chunks.length = 0;
        if (!res.writableEnded) reply(res, 413, "Request body too large");
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(bytes > MAX_REQUEST_BYTES ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function createNetworkServer(config: NetworkConfig) {
  const expectedTokenHash = createHash("sha256").update(config.bearerToken).digest();
  const allowedOrigins = new Set(config.allowedOrigins);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (config.transport === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    // Native MCP clients omit Origin. Browser origins require an exact allowlist;
    // never derive trusted origins from Host or client-supplied proxy headers.
    if (req.headers.origin !== undefined && !allowedOrigins.has(req.headers.origin)) {
      reply(res, 403, "Origin not allowed");
      return;
    }
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(req.headers.authorization ?? "");
    const suppliedHash = createHash("sha256").update(match?.[1] ?? "").digest();
    if (!match || !timingSafeEqual(expectedTokenHash, suppliedHash)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="gsuite-mcp"');
      reply(res, 401, "Unauthorized");
      return;
    }
    // Queries are not an authentication channel and there are no file routes.
    if (req.url !== "/mcp") {
      reply(res, 404, "Not found");
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      reply(res, 405, "This stateless MCP endpoint accepts POST requests");
      return;
    }
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      reply(res, 415, "Content-Type must be application/json");
      return;
    }
    if (Number(req.headers["content-length"]) > MAX_REQUEST_BYTES) {
      reply(res, 413, "Request body too large");
      req.resume();
      return;
    }
    const body = await readBody(req, res);
    if (body === null || res.destroyed) return;
    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      reply(res, 400, "Invalid JSON");
      return;
    }
    // The SDK treats null/undefined as an unparsed body.
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      reply(res, 400, "Expected a JSON-RPC message object");
      return;
    }

    const server = createMcpServer({ remote: true });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    // Install cleanup before handling: JSON replies can finish immediately, and
    // concurrent requests must never share a mutable MCP transport.
    res.once("close", () => { void server.close().catch(() => undefined); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, message);
    } catch {
      await server.close().catch(() => undefined);
      if (!res.headersSent) reply(res, 500, "Internal server error");
      else res.end();
    }
  }

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => {
      // Never serialize upstream errors: Google request objects may contain
      // Authorization headers or refresh credentials.
      console.error("[gsuite-mcp] request failed");
      if (!res.headersSent) reply(res, 500, "Internal server error");
      else res.end();
    });
  };
  const server = config.transport === "https"
    ? createHttpsServer({
        cert: await readFile(config.tlsCertFile!),
        key: await readFile(config.tlsKeyFile!),
        minVersion: "TLSv1.2",
      }, listener)
    : createHttpServer(listener);
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  return server;
}
