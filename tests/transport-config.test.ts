import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTransportConfig } from "../src/config.js";

const base = {
  GSUITE_MCP_TRANSPORT: "https",
  GSUITE_MCP_BEARER_TOKEN: "a".repeat(64),
  GSUITE_MCP_TLS_CERT_FILE: "/server/cert.pem",
  GSUITE_MCP_TLS_KEY_FILE: "/server/key.pem",
};

test("transport configuration defaults to stdio and fails closed for remote modes", async () => {
  assert.deepEqual(await loadTransportConfig({}), { transport: "stdio" });
  await assert.rejects(loadTransportConfig({ GSUITE_MCP_TRANSPORT: "sse" }), /must be stdio/);
  await assert.rejects(loadTransportConfig({ ...base, GSUITE_MCP_BEARER_TOKEN: undefined }), /bearer token/);
  await assert.rejects(loadTransportConfig({ ...base, GSUITE_MCP_BEARER_TOKEN: "short" }), /bearer token/);
  await assert.rejects(loadTransportConfig({ ...base, GSUITE_MCP_TLS_CERT_FILE: undefined }), /HTTPS requires/);
  await assert.rejects(loadTransportConfig({ ...base, GSUITE_MCP_TLS_KEY_FILE: undefined }), /HTTPS requires/);
  for (const port of ["", "0", "-1", "65536", "12abc", "8.5"]) {
    await assert.rejects(loadTransportConfig({ ...base, GSUITE_MCP_PORT: port }), /GSUITE_MCP_PORT/);
  }
  for (const origin of ["*", "null", "ftp://localhost", "http://localhost", "https://client.example/path", "http://client.example/path"]) {
    await assert.rejects(loadTransportConfig({ ...base, GSUITE_MCP_ALLOWED_ORIGINS: origin }), /exact HTTPS origins/);
  }
  const config = await loadTransportConfig(base);
  assert.equal(config.transport, "https");
  if (config.transport !== "stdio") {
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8443);
    assert.deepEqual(config.allowedOrigins, []);
  }
});

test("HTTP is restricted to authenticated loopback backends for HTTPS proxies", async () => {
  const env = {
    GSUITE_MCP_TRANSPORT: "http",
    GSUITE_MCP_BEARER_TOKEN: "a".repeat(64),
    GSUITE_MCP_ALLOWED_ORIGINS: "https://client.example",
  };
  for (const host of ["0.0.0.0", "::", "localhost", "server.example", "192.168.1.10"]) {
    await assert.rejects(loadTransportConfig({ ...env, GSUITE_MCP_HOST: host }), /only allowed/);
    const httpsConfig = await loadTransportConfig({ ...base, GSUITE_MCP_HOST: host });
    assert.equal(httpsConfig.transport, "https");
  }
  for (const host of ["127.0.0.1", "::1"]) {
    const config = await loadTransportConfig({ ...env, GSUITE_MCP_HOST: host });
    if (config.transport !== "http") assert.fail("expected HTTP");
    assert.equal(config.host, host);
    assert.equal(config.port, 8080);
    assert.equal(config.tlsCertFile, undefined);
    assert.equal(config.tlsKeyFile, undefined);
    assert.deepEqual(config.allowedOrigins, ["https://client.example"]);
  }
  await assert.rejects(loadTransportConfig({ ...env, GSUITE_MCP_BEARER_TOKEN: undefined }), /bearer token/);
});

test("HTTP can bind a private container network only with an explicit opt-in", async () => {
  const env = {
    GSUITE_MCP_TRANSPORT: "http",
    GSUITE_MCP_HOST: "0.0.0.0",
    GSUITE_MCP_BEARER_TOKEN: "a".repeat(64),
  };
  await assert.rejects(loadTransportConfig({ ...env, GSUITE_MCP_ALLOW_PRIVATE_HTTP: "1" }), /only allowed/);
  const config = await loadTransportConfig({ ...env, GSUITE_MCP_ALLOW_PRIVATE_HTTP: "true" });
  if (config.transport !== "http") assert.fail("expected HTTP");
  assert.equal(config.host, "0.0.0.0");
  await assert.rejects(
    loadTransportConfig({ ...env, GSUITE_MCP_ALLOW_PRIVATE_HTTP: "true", GSUITE_MCP_BEARER_TOKEN: undefined }),
    /bearer token/,
  );
});

test("MCP access keys can be read from a mounted secret file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gsuite-config-"));
  try {
    const file = join(dir, "bearer-token");
    await writeFile(file, `${"b".repeat(64)}\n`, { mode: 0o600 });
    const config = await loadTransportConfig({ ...base, GSUITE_MCP_BEARER_TOKEN: undefined, GSUITE_MCP_BEARER_TOKEN_FILE: file });
    if (config.transport === "stdio") assert.fail("expected HTTPS");
    assert.equal(config.bearerToken, "b".repeat(64));
    await assert.rejects(loadTransportConfig({ ...base, GSUITE_MCP_BEARER_TOKEN_FILE: file }), /Set only one/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
