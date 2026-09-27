const assert = require("assert");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const http = require("node:http");
const os = require("os");
const path = require("path");

const HELPER = path.join(__dirname, "..", "skills", "frank-cloud", "scripts", "frank-cloud-post.sh");
const BASE = "http://127.0.0.1:8789";
const BOOTSTRAP_TOKEN = "integration-bootstrap-token";

let worker = null;
let ws = null;
let agentToken = null;

function request(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForWorker() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await request("GET", `${BASE}/health`);
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Worker did not become ready");
}

function runHelper(args, env = {}) {
  return execFileSync(HELPER, args, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      FRANK_CLOUD_BASE: BASE,
      FRANK_CLOUD_WS: ws,
      FRANK_CLOUD_TOKEN: agentToken,
      ...env,
    },
  });
}

function runHelperFails(args, env = {}) {
  try {
    runHelper(args, env);
    return null;
  } catch (err) {
    return { code: err.status, stderr: err.stderr };
  }
}

// Runs the helper with a fake curl that records its arguments and fails, in an
// empty HOME so no real frankrc is loaded. Returns the exit code, stderr, and
// the recorded curl calls. Never touches the network.
function runWithFakeCurl(args, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frank-guard-"));
  try {
    const bin = path.join(dir, "bin");
    const log = path.join(dir, "curl.log");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(dir, "home"));
    fs.writeFileSync(path.join(bin, "curl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_CURL_LOG"\nexit 7\n', { mode: 0o755 });
    let code = 0;
    let stderr = "";
    try {
      execFileSync(HELPER, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: path.join(dir, "home"),
          XDG_CONFIG_HOME: path.join(dir, "home", ".config"),
          FAKE_CURL_LOG: log,
          FRANK_CLOUD_WS: "wsp_guard",
          FRANK_CLOUD_TOKEN: "frank_agent_guard",
          ...env,
        },
      });
    } catch (err) {
      code = err.status;
      stderr = String(err.stderr || "");
    }
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    return { code, stderr, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testHttpsGuard() {
  // Plain http, look-alike hosts, and userinfo tricks are refused before curl runs.
  const refused = [
    [["status-view"], "http://frank.example"],
    [["skill-update"], "http://frank.example"],
    [["bootstrap", "Guard"], "http://frank.example"],
    [["redeem", "/a/frank_setup_x"], "http://frank.example"],
    [["status-view"], "http://127.0.0.1:8789@evil.example"],
    [["status-view"], "http://localhost.evil.example"],
    [["status-view"], "http://127.0.0.1.evil.example"],
    [["status-view"], "ftp://frank.example"],
  ];
  for (const [args, base] of refused) {
    const r = runWithFakeCurl(args, { FRANK_CLOUD_BASE: base });
    assert.strictEqual(r.code, 1, `${args[0]} with ${base} should exit 1`);
    assert.match(r.stderr, /must use https:\/\//, `${args[0]} with ${base} should explain the refusal`);
    assert.deepStrictEqual(r.calls, [], `${args[0]} with ${base} must not reach curl`);
  }
  // A setup link on plain http is refused even when the base is https.
  const link = runWithFakeCurl(["redeem", "http://evil.example/a/frank_setup_x"], { FRANK_CLOUD_BASE: "https://frank.example" });
  assert.strictEqual(link.code, 1, "http setup link should be refused");
  assert.deepStrictEqual(link.calls, [], "http setup link must not reach curl");

  // https and loopback http pass the guard (the fake curl then fails the command).
  for (const base of ["https://frank.example", "http://127.0.0.1:9", "http://localhost:9/", "http://[::1]:9"]) {
    const r = runWithFakeCurl(["status-view"], { FRANK_CLOUD_BASE: base });
    assert.strictEqual(r.calls.length, 1, `${base} should reach curl`);
  }
  // redeem resolves a bare setup path against the base instead of passing "/a/…" to curl.
  const redeem = runWithFakeCurl(["redeem", "/a/frank_setup_x"], { FRANK_CLOUD_BASE: "https://frank.example/" });
  assert.match(redeem.calls[0] || "", /https:\/\/frank\.example\/a\/frank_setup_x/, "redeem should request the full setup URL");
  const full = runWithFakeCurl(["redeem", "https://frank.example/a/frank_setup_y"], { FRANK_CLOUD_BASE: "https://frank.example" });
  assert.match(full.calls[0] || "", /https:\/\/frank\.example\/a\/frank_setup_y/, "redeem should request a full setup link as given");
}

async function main() {
  testHttpsGuard();

  const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "frank-helper-"));
  // Apply D1 migrations to a fresh local persistence dir so the worker has the
  // bootstrap_quota table without depending on committed .wrangler state.
  execFileSync(
    "npx",
    [
      "wrangler", "d1", "migrations", "apply", "frank-cloud-directory", "--local",
      "--persist-to", persistDir,
    ],
    { cwd: path.join(__dirname, ".."), stdio: "ignore" },
  );
  worker = spawn(
    "npx",
    [
      "wrangler", "dev", "--local", "--port", "8789",
      "--persist-to", persistDir,
      "--var", "BOOTSTRAP_QUOTA_PER_HOUR:100",
      "--var", "BOOTSTRAP_TOTAL_CEILING:100",
      "--var", "BOOTSTRAP_CLIENT_CEILING:100",
      "--var", `BOOTSTRAP_TOKEN:${BOOTSTRAP_TOKEN}`,
    ],
    { cwd: path.join(__dirname, ".."), stdio: "ignore" },
  );
  try {
    await waitForWorker();

    // 1. Public bootstrap requires an idempotency key.
    const missingKey = await request(
      "POST",
      `${BASE}/v1/workspaces`,
      { "content-type": "application/json" },
      JSON.stringify({ agentLabel: "x" }),
    );
    assert.strictEqual(missingKey.status, 400, "bootstrap without idempotency key should 400");

    // 2. Public bootstrap succeeds without an operator token.
    const publicResult = await request(
      "POST",
      `${BASE}/v1/workspaces`,
      {
        "content-type": "application/json",
        "idempotency-key": "integration-public-bootstrap-key-001",
      },
      JSON.stringify({ agentLabel: "public-integration-agent" }),
    );
    assert.strictEqual(publicResult.status, 201, "public bootstrap should 201");

    // 3. An explicitly invalid operator token is rejected.
    const invalid = await request(
      "POST",
      `${BASE}/v1/workspaces`,
      {
        "content-type": "application/json",
        "bootstrap-token": "wrong-token",
        "idempotency-key": "integration-invalid-token-key-001",
      },
      JSON.stringify({ agentLabel: "invalid-agent" }),
    );
    assert.strictEqual(invalid.status, 403, "invalid bootstrap token should 403");

    // 4. Authorized bootstrap creates a workspace.
    const auth = await request(
      "POST",
      `${BASE}/v1/workspaces`,
      {
        "content-type": "application/json",
        "bootstrap-token": BOOTSTRAP_TOKEN,
        "idempotency-key": "integration-operator-bootstrap-key-001",
      },
      JSON.stringify({ agentLabel: "integration-agent", timeZone: "UTC" }),
    );
    assert.strictEqual(auth.status, 201, `authorized bootstrap should 201, got ${auth.status}`);
    const cred = JSON.parse(auth.body);
    ws = cred.workspace.id;
    agentToken = cred.agentCredential.token;
    assert.ok(ws.startsWith("wsp_"), "workspace id prefix");
    assert.ok(agentToken.startsWith("frank_agent_"), "agent token prefix");

    // 5. The bootstrap helper safely handles apostrophes in user input.
    const quoted = JSON.parse(
      runHelper(["bootstrap", "Nate's Workspace", "America/Chicago", "Hermes' CLI"]),
    );
    assert.ok(quoted.workspace.id.startsWith("wsp_"));
    assert.ok(quoted.agentCredential.token.startsWith("frank_agent_"));

    // 6. remote-check succeeds.
    assert.match(runHelper(["remote-check"]), /check passed/, "remote-check");

    // 7. self-test writes + verifies a marked synthetic entry.
    assert.match(runHelper(["self-test"]), /self-test passed/, "self-test marker round-trip");

    // 8. Create + read an ordinary note.
    runHelper(["note", "integration note text", "Integration Project"]);
    const listOut = runHelper(["list", "--project", "Integration Project"]);
    assert.match(listOut, /integration note text/, "note readable back");

    // 8b. Full backup to a file and back from stdout both carry the note.
    const backupFile = `${os.tmpdir()}/frank-backup-${process.pid}.json`;
    try {
      runHelper(["backup", backupFile]); // writes file (notice goes to stderr)
      const fromFile = JSON.parse(fs.readFileSync(backupFile, "utf8"));
      assert.ok(
        JSON.stringify(fromFile.entries).includes("integration note text"),
        "backup file contains the note",
      );
      const fromStdout = JSON.parse(runHelper(["backup"]));
      assert.ok(
        JSON.stringify(fromStdout.entries).includes("integration note text"),
        "backup stdout contains the note",
      );
    } finally {
      try { fs.unlinkSync(backupFile); } catch {}
    }

    // 9. Exercise project history.
    assert.match(runHelper(["history", "Integration Project"]), /integration note text/, "history");

    // 10. Project pagination options are carried through by the helper.
    const projectPage = JSON.parse(runHelper(["projects", "--limit", "1", "--offset", "0"]));
    assert.ok(Array.isArray(projectPage.projects), "projects response shape");
    assert.ok(projectPage.projects.length <= 1, "projects limit is honored");

    // 11. Idempotency: same key twice returns the original entry.
    const idemKey = "integration-fixed-key";
    const first = JSON.parse(
      runHelper(["note", "idempotent-note", "IdemProj"], { FRANK_IDEM_KEY: idemKey }),
    ).entry.id;
    const second = JSON.parse(
      runHelper(["note", "idempotent-note", "IdemProj"], { FRANK_IDEM_KEY: idemKey }),
    ).entry.id;
    assert.strictEqual(second, first, "idempotent note should reuse the same entry");

    // 12. Invalid credential fails.
    assert.ok(
      runHelperFails(["remote-check"], { FRANK_CLOUD_TOKEN: "frank_agent_wrong" }),
      "invalid credential should fail",
    );

    // 13. Missing env vars fail.
    assert.ok(runHelperFails(["note", "x"], { FRANK_CLOUD_TOKEN: "" }), "missing env should fail");

    // 14. URL encoding for project names with spaces/special chars.
    const proj = "A Project/With Special & Chars";
    runHelper(["note", "url-enc-test", proj]);
    assert.match(runHelper(["list", "--project", proj]), /url-enc-test/, "URL-encoded project");

    // 15. Agent can close a todo via the helper's close command.
    const todo = JSON.parse(
      runHelper(["todo", "helper-closable-todo", "Integration Project"]),
    ).entry;
    const closed = JSON.parse(runHelper(["close", String(todo.id)]));
    assert.strictEqual(closed.entry.status, "closed", "agent close via helper");
    const openAfter = JSON.parse(runHelper(["open"]));
    assert.ok(
      !openAfter.entries.some((e) => e.id === todo.id),
      "closed todo no longer appears in open loops",
    );

    console.log("frank-cloud-helper tests passed");
  } finally {
    worker.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
