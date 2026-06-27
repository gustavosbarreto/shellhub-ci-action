// Self-test: stands up a mock ShellHub API, runs index.js through its main and
// post phases the way the GitHub runner does, and asserts the device lifecycle
// (register -> accept -> tag -> delete) happened. No Docker, no ShellHub, no deps.
//
// It does NOT prove the agent gives a real host shell -- that needs a real runner
// and is covered by the integration workflow. This guards the action's control
// logic, which is where regressions actually happen.

"use strict";

const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const NAME = "ci-selftest-device";
const UID = "selftest-uid-0001";

const TENANT = "00000000-0000-4000-0000-000000000000";
const calls = { listed: 0, accepted: false, tagCreated: false, tagPushed: false, keyAuthorized: false, keyRemoved: false, deleted: false };

// --- mock ShellHub ----------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = req.url;
  // install.sh stand-in: a no-op script (the real one installs the agent).
  if (url === "/install.sh") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("#!/bin/sh\necho '[mock] agent installed'\nexit 0\n");
  }
  if (url.startsWith("/api/devices?status=pending")) {
    calls.listed++;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify([{ name: NAME, uid: UID }]));
  }
  if (req.method === "PATCH" && url === `/api/devices/${UID}/accept`) {
    calls.accepted = true;
    res.writeHead(200);
    return res.end();
  }
  if (req.method === "POST" && url === "/api/tags") {
    calls.tagCreated = true;
    res.writeHead(201);
    return res.end();
  }
  if (req.method === "POST" && url.startsWith(`/api/devices/${UID}/tags/`)) {
    calls.tagPushed = true;
    res.writeHead(200);
    return res.end();
  }
  if (req.method === "POST" && url === "/api/sshkeys/public-keys") {
    calls.keyAuthorized = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ fingerprint: "aa:bb:cc:dd" }));
  }
  if (req.method === "DELETE" && url.startsWith("/api/sshkeys/public-keys/")) {
    calls.keyRemoved = true;
    res.writeHead(200);
    return res.end();
  }
  if (req.method === "DELETE" && url === `/api/devices/${UID}`) {
    calls.deleted = true;
    res.writeHead(200);
    return res.end();
  }
  res.writeHead(404);
  res.end();
});

// --- run the action like the runner does ------------------------------------

function runPhase(server, stateFile, extraEnv) {
  const env = {
    ...process.env,
    GITHUB_STATE: stateFile,
    GITHUB_OUTPUT: stateFile + ".out",
    GITHUB_WORKSPACE: os.tmpdir(),
    "INPUT_SERVER": server,
    "INPUT_TENANT-ID": TENANT,
    "INPUT_API-KEY": "selftest-key",
    "INPUT_NAME": NAME,
    "INPUT_TAGS": "github",
    "INPUT_PUBLIC-KEY": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISELFTESTKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxx ci",
    "INPUT_DETACHED": "true", // don't block in main
    "INPUT_TIMEOUT": "0",
    "INPUT_AGENT-VERSION": "",
    ...extraEnv,
  };
  // spawn (async) not spawnSync: the mock API lives in this same process, so the
  // event loop must stay free to serve index.js's requests while it runs.
  return new Promise((resolve) => {
    const child = spawn("node", [path.join(__dirname, "..", "index.js")], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function parseState(file) {
  const state = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) state[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  return state;
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const stateFile = path.join(os.tmpdir(), `selftest-state-${process.pid}`);
  fs.writeFileSync(stateFile, "");

  // main phase
  const main = await runPhase(base, stateFile, { "INPUT_INSTALL-URL": `${base}/install.sh` });
  process.stdout.write(main.stdout || "");
  process.stderr.write(main.stderr || "");
  assert(main.status === 0, "main phase exits 0");

  const outputs = parseState(stateFile + ".out");
  assert(outputs["device-uid"] === UID, "set the device-uid output");
  assert(/\.connect=true$|\?connect=true$/.test(outputs["web-url"] || ""), "set the web-url output");
  assert((outputs["sshid"] || "").includes(NAME), "set the sshid output");
  assert(/^ssh \S+@/.test(outputs["ssh-command"] || ""), "set the ssh-command output with a username");

  const state = parseState(stateFile);
  const stateEnv = {};
  for (const [k, v] of Object.entries(state)) stateEnv[`STATE_${k}`] = v;

  // post phase (runner re-runs the same file with STATE_* exported)
  const post = await runPhase(base, stateFile, {
    ...stateEnv,
    "INPUT_INSTALL-URL": `${base}/install.sh`,
  });
  process.stdout.write(post.stdout || "");
  process.stderr.write(post.stderr || "");
  assert(post.status === 0, "post phase exits 0");

  // assertions on the lifecycle
  assert(calls.listed > 0, "listed pending devices");
  assert(calls.accepted, "accepted the device");
  assert(calls.tagCreated, "created the tag");
  assert(calls.tagPushed, "pushed the tag to the device");
  assert(calls.keyAuthorized, "authorized the provided public key");
  assert(calls.keyRemoved, "removed the authorized key in the post phase");
  assert(state.uid === UID, "saved the device uid to state");
  assert(calls.deleted, "deleted the device in the post phase");

  server.close();
  console.log(process.exitCode ? "\nSELF-TEST FAILED" : "\nSELF-TEST PASSED");
});
