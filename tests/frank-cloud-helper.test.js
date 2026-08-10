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

async function main() {
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

    console.log("frank-cloud-helper tests passed");
  } finally {
    worker.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
