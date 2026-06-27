// ShellHub CI Debug action.
//
// Registers the CI runner as an ephemeral ShellHub device so you can SSH into a
// live build through your own ShellHub gateway (recorded, RBAC, central keys).
//
// Single file, runs in both the main and post phases (see action.yml). Written
// against the Node 20 runtime with zero dependencies: there is no build step and
// nothing to bundle, so the file you read is the file that runs.

"use strict";

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// --- minimal @actions/core surface, reimplemented to avoid a build step ------

function getInput(name) {
  const key = "INPUT_" + name.replace(/ /g, "_").toUpperCase();
  return (process.env[key] || "").trim();
}

function saveState(name, value) {
  const file = process.env.GITHUB_STATE;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
}

function getState(name) {
  return process.env["STATE_" + name] || "";
}

function mask(secret) {
  if (secret) console.log(`::add-mask::${secret}`);
}

function notice(msg) {
  console.log(`::notice::${msg}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- ShellHub API ------------------------------------------------------------

function api(server, apiKey, method, route, body) {
  const headers = { "X-API-Key": apiKey };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${server}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function findPendingUID(server, apiKey, name) {
  const res = await api(
    server,
    apiKey,
    "GET",
    "/api/devices?status=pending&per_page=100",
  );
  if (!res.ok) {
    throw new Error(`listing pending devices failed: HTTP ${res.status}`);
  }
  const devices = await res.json();
  const match = (devices || []).find((d) => d.name === name);
  return match ? match.uid : "";
}

// --- phases ------------------------------------------------------------------

async function main() {
  const server = getInput("server").replace(/\/+$/, "");
  const tenant = getInput("tenant-id");
  const apiKey = getInput("api-key");
  const name = getInput("name");
  const tags = getInput("tags").split(",").map((t) => t.trim()).filter(Boolean);
  const detached = getInput("detached") === "true";
  const timeout = parseInt(getInput("timeout") || "0", 10);
  const version = getInput("agent-version");
  const installURL = getInput("install-url") || `${server}/install.sh`;

  if (!tenant) {
    // The agent registers by tenant ID (not the API key), so it is required and
    // cannot be derived: the API blocks API keys from listing namespaces.
    throw new Error("tenant-id is required");
  }

  mask(apiKey);
  // Mark that the post phase should run teardown even if main fails midway.
  saveState("isPost", "true");
  saveState("server", server);

  // 1. Install the agent the official way. install.sh auto-detects Docker and
  //    runs it with --pid=host -v /:/host, so the SSH session lands on the
  //    runner host, not an isolated container. A unique identity per run means a
  //    fresh device every time (no dedup collision with a previous run).
  console.log(`Installing ShellHub agent as '${name}'...`);
  // install.sh reads these UNPREFIXED from the environment (and forwards them to
  // the container as SHELLHUB_*). Passing the SHELLHUB_-prefixed names here would
  // be silently ignored, and the agent would register with a random name.
  const env = {
    ...process.env,
    SERVER_ADDRESS: server,
    TENANT_ID: tenant,
    PREFERRED_HOSTNAME: name,
    PREFERRED_IDENTITY: name,
  };
  if (version) env.AGENT_VERSION = version;
  execSync(`curl -sSf "${installURL}" | sh`, { stdio: "inherit", env });

  // 2. Wait for the device to register (it shows up as pending), find it by the
  //    name we set, and grab its uid.
  let uid = "";
  for (let i = 0; i < 60 && !uid; i++) {
    try {
      uid = await findPendingUID(server, apiKey, name);
    } catch (err) {
      console.log(`  ${err.message}, retrying...`);
    }
    if (!uid) {
      if (i % 5 === 0) console.log(`  waiting for '${name}' to register...`);
      await sleep(2000);
    }
  }
  if (!uid) {
    throw new Error(`device '${name}' never registered as pending`);
  }
  saveState("uid", uid);
  console.log(`Device registered: ${uid}`);

  // 3. Accept it. (With namespace auto-accept off, the device stays pending
  //    until something accepts it; here the action does it via the API key.)
  const accept = await api(server, apiKey, "PATCH", `/api/devices/${uid}/accept`);
  if (!accept.ok) {
    throw new Error(`accepting device failed: HTTP ${accept.status}`);
  }
  console.log("Device accepted.");

  // 4. Tag it for access scoping. A tag must exist before it can be pushed, so
  //    create it first (ignoring "already exists"), then push. Best-effort:
  //    tagging never fails the job.
  for (const tag of tags) {
    await api(server, apiKey, "POST", "/api/tags", { name: tag }); // 409 if it exists; fine
    const res = await api(
      server,
      apiKey,
      "POST",
      `/api/devices/${uid}/tags/${encodeURIComponent(tag)}`,
    );
    if (!res.ok) console.log(`  could not apply tag '${tag}' (HTTP ${res.status})`);
  }

  // 5. Print how to connect. The SSH gateway resolves a device by its namespace
  //    NAME (not the tenant id), so read it back from the device.
  let namespace = tenant;
  try {
    const dres = await api(server, apiKey, "GET", `/api/devices/${uid}`);
    if (dres.ok) {
      const dev = await dres.json();
      if (dev && dev.namespace) namespace = dev.namespace;
    }
  } catch {
    /* fall back to the tenant id */
  }
  const host = new URL(server).hostname;
  const sshid = `${namespace}.${name}@${host}`;
  notice(`SSH into this runner:  ssh <user>@${sshid}`);

  if (detached) {
    console.log("Detached: the runner stays reachable while the job runs.");
    return;
  }

  // 6. Blocking mode: hold the job open so you have time to connect. Release by
  //    running `sudo touch /continue` inside the SSH session, or let it time out.
  const continueFiles = [
    "/continue",
    path.join(process.env.GITHUB_WORKSPACE || ".", "continue"),
  ];
  const deadline = timeout > 0 ? Date.now() + timeout * 1000 : Infinity;
  console.log(
    `Blocking. Connect via SSH above; run 'sudo touch /continue' to release` +
      (timeout > 0 ? ` (auto-release in ${timeout}s).` : "."),
  );
  while (Date.now() < deadline) {
    if (continueFiles.some((f) => fs.existsSync(f))) {
      console.log("Continue file found, releasing the job.");
      break;
    }
    notice(`Waiting for SSH. Connect:  ssh <user>@${sshid}`);
    await sleep(5000);
  }
}

async function post() {
  const uid = getState("uid");
  const server = getState("server");
  const apiKey = getInput("api-key");
  if (!uid || !server) {
    console.log("Nothing to tear down.");
    return;
  }

  // Delete the ephemeral device.
  try {
    const res = await api(server, apiKey, "DELETE", `/api/devices/${uid}`);
    console.log(`Removed device ${uid} (HTTP ${res.status}).`);
  } catch (err) {
    console.log(`Could not remove device: ${err.message}`);
  }

  // Stop the agent container.
  try {
    execSync(
      `docker ps -q --filter label=shellhub.role=agent | xargs -r docker rm -f`,
      { stdio: "inherit" },
    );
  } catch {
    /* agent may already be gone */
  }
}

(getState("isPost") ? post() : main()).catch((err) => {
  console.log(`::error::${err.message}`);
  process.exit(1);
});
