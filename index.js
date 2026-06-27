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
const crypto = require("node:crypto");
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

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${value}\n`);
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

// Collect the public keys to authorize: an explicit input and/or the GitHub keys
// of the user who triggered the run.
async function collectKeys(provided, useActor, quiet) {
  const keys = [];
  if (provided) {
    keys.push(...provided.split("\n").map((l) => l.trim()).filter(Boolean));
  }
  if (useActor) {
    const actor = process.env.GITHUB_ACTOR;
    if (!actor) {
      if (!quiet) console.log("  authorize-actor is on but GITHUB_ACTOR is unset; skipping.");
    } else {
      const res = await fetch(`https://github.com/${actor}.keys`);
      if (res.ok) {
        const text = await res.text();
        const actorKeys = text.split("\n").map((l) => l.trim()).filter(Boolean);
        // In 'auto' mode, an actor with no keys is a silent no-op; in 'true' it's
        // worth flagging, since the user explicitly asked for actor access.
        if (!actorKeys.length && !quiet) console.log(`  @${actor} has no public keys on GitHub.`);
        keys.push(...actorKeys);
      } else {
        console.log(`  could not fetch @${actor}'s keys (HTTP ${res.status}).`);
      }
    }
  }
  // De-dupe identical lines.
  return [...new Set(keys)];
}

// Register each public key in the namespace, scoped to the device's tags so it
// only grants access to the CI runners. Best-effort and idempotent: a key that
// already exists comes back as a conflict, which is fine.
// Returns the fingerprints of the keys this run actually created (HTTP 2xx), so
// the post phase can remove exactly those. A key that already existed (409) is
// left alone: it is someone else's, or a standing key the user manages.
async function authorizeKeys(server, apiKey, keys, username, tags) {
  const created = [];
  if (keys.length && !tags.length) {
    console.log("  cannot authorize keys without a tag to scope them to; skipping.");
    return created;
  }
  for (const key of keys) {
    const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
    const body = {
      name: `ci-${hash}`,
      username: username || ".*",
      data: Buffer.from(key).toString("base64"),
      filter: { tags },
    };
    const res = await api(server, apiKey, "POST", "/api/sshkeys/public-keys", body);
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body && body.fingerprint) created.push(body.fingerprint);
      console.log(`  authorized key ci-${hash} for ${username || ".*"}@[${tags.join(",")}]`);
    } else if (res.status !== 409) {
      console.log(`  could not authorize a key (HTTP ${res.status}).`);
    }
  }
  return created;
}

// Number of allocated pseudo-terminals on the runner. The agent gives each
// interactive host-mode session a PTY, and /dev is shared with the host (the
// install mounts -v /dev:/dev), so a new entry in /dev/pts means someone is
// connected, and it disappears when the shell exits (even on an abrupt
// disconnect, since the agent tears the PTY down). This detects connect/
// disconnect locally, with no ShellHub session API. (who/utmp does not work
// here: the agent does not produce a who-visible record in the Docker setup.)
function ptyCount() {
  try {
    return fs.readdirSync("/dev/pts").filter((n) => /^\d+$/.test(n)).length;
  } catch {
    return 0;
  }
}

// Hold the job open for an interactive debug session: wait up to connectTimeout
// for someone to connect, then hold until they disconnect. `sudo touch /continue`
// releases it manually at any point. connectTimeout <= 0 waits indefinitely for
// the first connection.
async function holdForDebug(sshid, connectTimeout, baseline) {
  const continueFiles = ["/continue", path.join(process.env.GITHUB_WORKSPACE || ".", "continue")];
  const deadline = connectTimeout > 0 ? Date.now() + connectTimeout * 1000 : Infinity;
  let connected = false;
  console.log(
    connectTimeout > 0
      ? `Waiting up to ${connectTimeout}s for a connection (or 'sudo touch /continue')...`
      : `Waiting for a connection (or 'sudo touch /continue')...`,
  );
  while (true) {
    if (continueFiles.some((f) => fs.existsSync(f))) {
      console.log("Continue file found; releasing.");
      return;
    }
    const active = ptyCount() > baseline;
    if (active && !connected) {
      connected = true;
      console.log("Connection detected; holding until you disconnect.");
    } else if (!active && connected) {
      console.log("Disconnected; releasing.");
      return;
    } else if (!connected && Date.now() > deadline) {
      console.log("No connection within the timeout; releasing.");
      return;
    }
    if (!connected && sshid) notice(`Waiting for SSH:  ssh <user>@${sshid}`);
    await sleep(5000);
  }
}

// --- phases ------------------------------------------------------------------

async function main() {
  const server = getInput("server").replace(/\/+$/, "");
  const tenant = getInput("tenant-id");
  const apiKey = getInput("api-key");
  const name = getInput("name");
  const tags = getInput("tags").split(",").map((t) => t.trim()).filter(Boolean);
  const publicKey = getInput("public-key");
  const actorMode = getInput("authorize-actor"); // "true" | "auto" | "false"
  const sshUsername = getInput("ssh-username") || ".*";
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
  // Snapshot the runner's PTYs now, before anyone could connect, so we can tell
  // a real debug session apart from any baseline PTY later.
  const ptsBaseline = ptyCount();
  saveState("ptsBaseline", String(ptsBaseline));

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

  // 4b. Authorize SSH keys so someone can actually connect: an explicit key
  //     and/or the triggering GitHub user's keys, scoped to the device's tags.
  const useActor = actorMode === "true" || actorMode === "auto";
  const keys = await collectKeys(publicKey, useActor, actorMode === "auto");
  if (keys.length) {
    console.log(`Authorizing ${keys.length} public key(s)...`);
    const created = await authorizeKeys(server, apiKey, keys, sshUsername, tags);
    // Remember only the keys we created so the post phase removes exactly those.
    if (created.length) saveState("createdKeys", created.join(","));
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
  const webURL = `${server}/devices/${uid}?connect=true`;
  notice(`SSH into this runner:  ssh <user>@${sshid}`);
  notice(`Web terminal:  ${webURL}`);
  setOutput("sshid", sshid);
  setOutput("web-url", webURL);
  setOutput("device-uid", uid);

  if (detached) {
    console.log("Detached: the runner stays reachable while the job runs.");
    return;
  }

  // 6. Blocking mode: wait for a connection (up to `timeout`), then hold until
  //    you disconnect. `sudo touch /continue` releases it manually.
  await holdForDebug(sshid, timeout, ptsBaseline);
}

async function post() {
  const uid = getState("uid");
  const server = getState("server");
  const apiKey = getInput("api-key");
  if (!uid || !server) {
    console.log("Nothing to tear down.");
    return;
  }

  // Detached + idle-timeout: at job end, wait up to idle-timeout for a connection
  // and then until it disconnects, before tearing down. Connection state comes
  // from /dev/pts on the runner (see holdForDebug), so no session API is needed.
  const idle = parseInt(getInput("idle-timeout") || "0", 10);
  if (getInput("detached") === "true" && idle > 0) {
    const baseline = parseInt(getState("ptsBaseline") || "0", 10);
    await holdForDebug("", idle, baseline);
  }

  // Remove the public keys this run authorized (ephemeral grants). Keys it did
  // not create are left untouched. Best-effort: needs the key remove permission.
  const createdKeys = getState("createdKeys");
  if (createdKeys) {
    for (const fp of createdKeys.split(",").filter(Boolean)) {
      try {
        const res = await api(server, apiKey, "DELETE", `/api/sshkeys/public-keys/${encodeURIComponent(fp)}`);
        if (!res.ok && res.status !== 404) {
          console.log(`::warning::could not remove authorized key ${fp} (HTTP ${res.status}).`);
        }
      } catch (err) {
        console.log(`::warning::could not remove authorized key ${fp}: ${err.message}`);
      }
    }
  }

  // Delete the ephemeral device.
  try {
    const res = await api(server, apiKey, "DELETE", `/api/devices/${uid}`);
    if (res.ok) {
      console.log(`Removed device ${uid}.`);
    } else {
      console.log(
        `::warning::could not remove device ${uid} (HTTP ${res.status}); ` +
          `it will linger. The API key needs the device remove permission.`,
      );
    }
  } catch (err) {
    console.log(`::warning::could not remove device ${uid}: ${err.message}`);
  }

  // Stop the agent container. Match it both ways across install.sh versions: by
  // the default container name and by the label that newer versions add.
  try {
    execSync(
      `docker rm -f shellhub >/dev/null 2>&1 || true; ` +
        `docker ps -q --filter label=shellhub.role=agent | xargs -r docker rm -f >/dev/null 2>&1 || true`,
      { stdio: "ignore" },
    );
  } catch {
    /* agent may already be gone, or this is not the Docker install path */
  }
}

(getState("isPost") ? post() : main()).catch((err) => {
  console.log(`::error::${err.message}`);
  process.exit(1);
});
