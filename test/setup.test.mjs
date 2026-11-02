// Drives the interactive `setup` wizard through a real terminal (via `expect`), against a local
// IMAP server, a stand-in `claude` CLI and a test-only Keychain service. macOS only.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const hoodiecrow = require("hoodiecrow-imap");

const SERVICE = "spacemail-mcp-test";
const runnable = process.platform === "darwin" && existsSync("/usr/bin/expect");

function keychainPassword(account) {
  try {
    return execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function cleanKeychain() {
  for (const account of ["support@example.test", "sales@example.test"]) {
    spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { stdio: "ignore" });
  }
}

describe("setup wizard", { skip: !runnable && "needs macOS and expect" }, () => {
  let imap;
  let dir;
  let env;

  before(async () => {
    cleanKeychain();
    imap = hoodiecrow({
      users: { "support@example.test": { password: "correct-horse" }, "sales@example.test": { password: "second-pass" } },
      storage: {
        INBOX: {
          messages: [
            { raw: "Subject: one\r\n\r\nhi", flags: ["\\Seen"] },
            { raw: "Subject: two\r\n\r\nhi", flags: [] },
          ],
        },
      },
    });
    const port = await new Promise((r) => imap.listen(0, "127.0.0.1", () => r(imap.address().port)));
    dir = mkdtempSync(join(tmpdir(), "spacemail-setup-"));
    env = {
      ...process.env,
      NO_COLOR: "1",
      SPACEMAIL_IMAP_HOST: "127.0.0.1",
      SPACEMAIL_IMAP_PORT: String(port),
      SPACEMAIL_INSECURE_PLAINTEXT: "true",
      SPACEMAIL_KEYCHAIN_SERVICE: SERVICE,
      SPACEMAIL_SETUP_CLAUDE_BIN: resolve("test/fixtures/fake-claude.mjs"),
      SPACEMAIL_SETUP_CLAUDE_CONFIG: join(dir, "claude.json"),
    };
  });

  after(async () => {
    cleanKeychain();
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => imap.close(r));
  });

  const config = () => JSON.parse(readFileSync(env.SPACEMAIL_SETUP_CLAUDE_CONFIG, "utf8")).mcpServers.spacemail;
  // Must not block: the IMAP server runs in this process and has to keep answering.
  const expectScript = (name) =>
    new Promise((done) => {
      execFile("expect", [`test/fixtures/${name}`], { env, encoding: "utf8", timeout: 60_000 }, (err, stdout, stderr) =>
        done({ status: err ? (err.code ?? 1) : 0, stdout, stderr }),
      );
    });

  it("sets up two mailboxes, checks each login and keeps passwords in the Keychain", async () => {
    const result = await expectScript("setup-new.exp");
    assert.equal(result.status, 0, `expect stopped at step ${result.status}\n${result.stdout}${result.stderr}`);

    const server = config();
    assert.equal(server.scope, "user");
    assert.equal(server.command, process.execPath);
    assert.deepEqual(server.args, [resolve("dist/index.cjs")]);
    assert.deepEqual(server.env, {
      SPACEMAIL_1_EMAIL: "support@example.test",
      SPACEMAIL_1_PASSWORD_COMMAND: `security find-generic-password -s ${SERVICE} -a 'support@example.test' -w`,
      SPACEMAIL_1_LABEL: "Support",
      SPACEMAIL_1_NAME: "Support",
      SPACEMAIL_2_EMAIL: "sales@example.test",
      SPACEMAIL_2_PASSWORD_COMMAND: `security find-generic-password -s ${SERVICE} -a 'sales@example.test' -w`,
      SPACEMAIL_2_LABEL: "Sales",
      SPACEMAIL_2_NAME: "Example Sales Team",
    });
    assert.ok(!JSON.stringify(server).includes("correct-horse"), "password must not be written to the config");
    assert.equal(keychainPassword("support@example.test"), "correct-horse");
    assert.equal(keychainPassword("sales@example.test"), "second-pass");
  });

  it("lets `check` use the saved settings", async () => {
    const { stdout: out } = await promisify(execFile)(process.execPath, ["dist/index.cjs", "check"], { env, encoding: "utf8" });
    assert.match(out, /Using the mailboxes saved in Claude Code/);
    assert.match(out, /✓ Support <support@example\.test>: 2 messages, 1 unread/);
    assert.match(out, /✓ Sales <sales@example\.test>/);
  });

  it("removes a mailbox and its Keychain entry on a second run", async () => {
    const result = await expectScript("setup-remove.exp");
    assert.equal(result.status, 0, `expect stopped at step ${result.status}\n${result.stdout}${result.stderr}`);
    const server = config();
    assert.equal(server.env.SPACEMAIL_1_EMAIL, "support@example.test");
    assert.equal(server.env.SPACEMAIL_2_EMAIL, undefined);
    assert.equal(keychainPassword("sales@example.test"), undefined);
    assert.equal(keychainPassword("support@example.test"), "correct-horse");
  });
});
