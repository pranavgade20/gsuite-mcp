import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("account selection defaults for one account and requires email for multiple accounts", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "gsuite-mcp-auth-"));
  process.env.GMAIL_MCP_CONFIG_DIR = configDir;

  try {
    const tokenPath = join(configDir, "token.json");
    await writeFile(
      tokenPath,
      JSON.stringify({
        version: 2,
        accounts: {
          "first@example.com": { refresh_token: "first-refresh-token", scope: "scope-one" },
        },
      }),
    );

    const auth = await import("../src/auth.js");
    await auth.initAuth();
    assert.equal(auth.getAccount().email, "first@example.com");

    await writeFile(
      tokenPath,
      JSON.stringify({
        version: 2,
        accounts: {
          "first@example.com": { refresh_token: "first-refresh-token", scope: "scope-one" },
          "second@example.com": { refresh_token: "second-refresh-token", scope: "scope-two" },
        },
      }),
    );
    await auth.initAuth();

    assert.throws(() => auth.getAccount(), /`email` parameter is required/);
    assert.equal(auth.getAccount("SECOND@EXAMPLE.COM").email, "second@example.com");
    assert.deepEqual(
      auth.listAccounts().map((account) => account.email),
      ["first@example.com", "second@example.com"],
    );
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
