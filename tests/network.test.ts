import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("HTTPS MCP keeps Google credentials on the server and handles independent clients", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gsuite-https-"));
  const previousConfigDir = process.env.GMAIL_MCP_CONFIG_DIR;
  process.env.GMAIL_MCP_CONFIG_DIR = dir;
  t.after(async () => {
    if (previousConfigDir === undefined) delete process.env.GMAIL_MCP_CONFIG_DIR;
    else process.env.GMAIL_MCP_CONFIG_DIR = previousConfigDir;
    await rm(dir, { recursive: true, force: true });
  });

  const certFile = join(dir, "cert.pem");
  const keyFile = join(dir, "key.pem");
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyFile, "-out", certFile, "-subj", "/CN=localhost",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ]);
  const googleSecret = "test-google-refresh-token-never-return-to-clients";
  await writeFile(join(dir, "token.json"), JSON.stringify({
    version: 2,
    accounts: { "owner@example.com": { refresh_token: googleSecret, scope: "test-scope" } },
  }));
  const { initAuth } = await import("../src/auth.js");
  const { createNetworkServer, MAX_REQUEST_BYTES } = await import("../src/network.js");
  await initAuth();
  const bearerToken = "a".repeat(64);
  const server = await createNetworkServer({
    transport: "https", host: "127.0.0.1", port: 0, bearerToken,
    tlsCertFile: certFile, tlsKeyFile: keyFile,
    allowedOrigins: ["https://trusted.example"],
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ca = await readFile(certFile);
  // Use actual certificate verification against the test CA; never disable TLS
  // checks globally. The SDK's fetch hook keeps this test dependency-free.
  const verifiedFetch: typeof fetch = async (input, init) => {
    return new Promise<Response>((resolve, reject) => {
      const url = input instanceof Request ? input.url : input.toString();
      const req = request(url, {
        ca,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers)),
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode,
          headers: res.headers as Record<string, string>,
        })));
      });
      req.on("error", reject);
      req.end(init?.body);
    });
  };
  const headers = {
    Authorization: `Bearer ${bearerToken}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const listBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  await t.test("missing/incorrect keys and query-string tokens cannot access MCP", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const res = await verifiedFetch(`${baseUrl}/mcp`, { method });
      assert.equal(res.status, 401);
      assert.match(res.headers.get("www-authenticate")!, /Bearer/);
    }
    const wrong = await verifiedFetch(`${baseUrl}/mcp`, { headers: { Authorization: `Bearer ${"b".repeat(64)}` } });
    assert.equal(wrong.status, 401);
    const query = await verifiedFetch(`${baseUrl}/mcp?access_token=${bearerToken}`);
    assert.equal(query.status, 401);
    assert.equal((await verifiedFetch(`${baseUrl}/token.json`, { headers })).status, 404);
    assert.equal((await verifiedFetch(`${baseUrl}/mcp`, { headers })).status, 405);
  });

  await t.test("untrusted origins fail even with valid authentication", async () => {
    const rejected = await verifiedFetch(`${baseUrl}/mcp`, {
      method: "POST", headers: { ...headers, Origin: "https://attacker.example" }, body: listBody,
    });
    assert.equal(rejected.status, 403);
    const allowed = await verifiedFetch(`${baseUrl}/mcp`, {
      method: "POST", headers: { ...headers, Origin: "https://trusted.example" }, body: listBody,
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("cache-control"), "no-store");
  });

  await t.test("invalid and oversized request bodies fail before tool dispatch", async () => {
    for (const body of ["{", "null", "[]", "false"]) {
      const res = await verifiedFetch(`${baseUrl}/mcp`, { method: "POST", headers, body });
      assert.equal(res.status, 400);
    }
    const wrongType = await verifiedFetch(`${baseUrl}/mcp`, {
      method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: listBody,
    });
    assert.equal(wrongType.status, 415);
    // No Content-Length: exercise the streaming size limit as well as preflight.
    const oversized = await verifiedFetch(`${baseUrl}/mcp`, {
      method: "POST", headers, body: " ".repeat(MAX_REQUEST_BYTES + 1),
    });
    assert.equal(oversized.status, 413);
    const oversizedDeclared = await verifiedFetch(`${baseUrl}/mcp`, {
      method: "POST", headers: { ...headers, "Content-Length": String(MAX_REQUEST_BYTES + 1) },
    });
    assert.equal(oversizedDeclared.status, 413);
  });

  await t.test("SDK clients initialize, list and call tools concurrently over verified TLS", async () => {
    const clients = [0, 1].map((id) => new Client({ name: `test-${id}`, version: "1.0.0" }));
    try {
      await Promise.all(clients.map((client) => client.connect(new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/mcp`), { fetch: verifiedFetch, requestInit: { headers } },
      ))));
      await Promise.all(clients.map(async (client) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        for (const name of ["gmail_search", "calendar_list_events", "docs_read_document", "sheets_read_values", "drive_read_file", "setup_list_accounts"]) {
          assert.ok(names.includes(name), `${name} should be available remotely`);
        }
        for (const name of ["setup_auth", "setup_add_account", "gmail_download_attachments", "gmail_bulk_export", "drive_download_file"]) {
          assert.ok(!names.includes(name), `${name} must not be exposed remotely`);
          const result = await client.callTool({ name, arguments: {} });
          assert.equal(result.isError, true, `${name} must not be callable directly`);
        }
        const result = await client.callTool({ name: "setup_list_accounts", arguments: {} });
        assert.ok(!result.isError);
        const json = JSON.stringify(result);
        assert.ok(json.includes("owner@example.com"));
        assert.ok(!json.includes(googleSecret));
        assert.ok(!json.includes("refresh_token"));
        assert.ok(!json.includes(bearerToken));
      }));
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});

test("loopback HTTP serves authenticated MCP behind an HTTPS proxy", async (t) => {
  const { loadTransportConfig } = await import("../src/config.js");
  const { createNetworkServer } = await import("../src/network.js");
  const bearerToken = "http-test-key-".repeat(4);
  const config = await loadTransportConfig({
    GSUITE_MCP_TRANSPORT: "http",
    GSUITE_MCP_HOST: "127.0.0.1",
    GSUITE_MCP_BEARER_TOKEN: bearerToken,
    GSUITE_MCP_ALLOWED_ORIGINS: "https://agent.example",
  });
  if (config.transport !== "http") assert.fail("expected HTTP");
  const server = await createNetworkServer(config);
  await new Promise<void>((resolve) => server.listen(0, config.host, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  assert.equal((server.address() as AddressInfo).address, "127.0.0.1");
  const unauthorized = await fetch(url);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("strict-transport-security"), null);
  await unauthorized.text();
  const wrongOrigin = await fetch(url, {
    headers: { Authorization: `Bearer ${bearerToken}`, Origin: "http://untrusted:3000" },
  });
  assert.equal(wrongOrigin.status, 403);
  await wrongOrigin.text();

  const client = new Client({ name: "http-agent", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${bearerToken}`, Origin: "https://agent.example" } },
    }));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("gmail_search"));
    for (const name of ["setup_auth", "setup_add_account", "drive_download_file", "gmail_download_attachments", "gmail_bulk_export"]) {
      assert.ok(!names.includes(name), `${name} must remain local only over HTTP`);
    }
    const result = await client.callTool({ name: "setup_list_accounts", arguments: {} });
    assert.ok(!result.isError);
    assert.ok(!JSON.stringify(result).includes("refresh_token"));
  } finally {
    await client.close();
  }
});
