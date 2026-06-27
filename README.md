# ShellHub CI Debug Action

SSH into a live CI runner to debug a failing build, through your own ShellHub
gateway. Unlike `action-tmate`, the session goes through ShellHub, so it is
recorded, RBAC-gated, and uses your central keys. No session URL is printed to
public logs.

The action installs the ShellHub agent on the runner, registers it as an
ephemeral device, accepts it, and removes it when the job ends.

## Usage

```yaml
- uses: shellhub-io/ci-action@v1
  with:
    server: https://cloud.shellhub.io
    tenant-id: ${{ secrets.SHELLHUB_TENANT_ID }}
    api-key: ${{ secrets.SHELLHUB_API_KEY }}
```

By default the job blocks at this step so you have time to connect. Run
`sudo touch /continue` inside the SSH session to release it.

Connect with the SSHID printed in the job log:

```
ssh <user>@<tenant>.ci-<run_id>-<attempt>@cloud.shellhub.io
```

The agent runs with host access, so the shell lands on the runner itself, not an
isolated container.

### Only when a previous step failed

```yaml
- name: build
  run: make
- uses: shellhub-io/ci-action@v1
  if: failure()
  with:
    server: https://cloud.shellhub.io
    tenant-id: ${{ secrets.SHELLHUB_TENANT_ID }}
    api-key: ${{ secrets.SHELLHUB_API_KEY }}
    timeout: 1800
```

### Detached

Stay reachable for the rest of the job instead of blocking:

```yaml
- uses: shellhub-io/ci-action@v1
  with:
    server: https://cloud.shellhub.io
    tenant-id: ${{ secrets.SHELLHUB_TENANT_ID }}
    api-key: ${{ secrets.SHELLHUB_API_KEY }}
    detached: true
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `server` | yes | | ShellHub server address |
| `tenant-id` | yes | | Namespace tenant ID |
| `api-key` | yes | | API key with device accept/remove permission (use a secret) |
| `name` | no | `ci-<run_id>-<attempt>` | Device name |
| `tags` | no | `github` | Comma-separated tags for access scoping |
| `public-key` | no | | SSH public key(s) to authorize, in authorized_keys format (one per line) |
| `authorize-actor` | no | `false` | Authorize the GitHub keys of the user who triggered the run |
| `ssh-username` | no | `.*` | Username (regexp) the authorized keys may log in as |
| `detached` | no | `false` | Continue the job instead of blocking |
| `timeout` | no | `0` | Max seconds to block in blocking mode (0 = indefinite) |
| `idle-timeout` | no | `0` | In detached mode, seconds the post step waits for a connection at job end (0 = tear down immediately) |
| `agent-version` | no | server's version | Pin the agent version |
| `install-url` | no | `<server>/install.sh` | Override the install script URL |

## Outputs

| Output | Description |
|--------|-------------|
| `sshid` | The SSHID to connect (`<namespace>.<device>@<host>`) |
| `web-url` | Browser URL that opens the runner's web terminal in the ShellHub console |
| `device-uid` | The ephemeral device UID |

The job log prints both an `ssh` command and a `web-url`. Open the `web-url` to get
a terminal into the runner straight from your browser, through the ShellHub console
(so it keeps login, RBAC, and recording).

## Authorizing access

To SSH in, your public key must be authorized in ShellHub, scoped to the device's
tags. There are three ways:

1. **Manage it yourself** (default) — register your key once in ShellHub, scoped
   to the `github` tag. Every CI runner this action registers is then reachable.
2. **Provide a key** — pass it to the action; it registers the key scoped to the
   tags:

   ```yaml
   - uses: shellhub-io/ci-action@v1
     with:
       server: https://cloud.shellhub.io
       tenant-id: ${{ secrets.SHELLHUB_TENANT_ID }}
       api-key: ${{ secrets.SHELLHUB_API_KEY }}
       public-key: ${{ secrets.MY_SSH_PUBLIC_KEY }}
   ```

3. **Use the triggering user's GitHub keys** — fetch them from
   `github.com/<actor>.keys` automatically:

   ```yaml
   - uses: shellhub-io/ci-action@v1
     with:
       server: https://cloud.shellhub.io
       tenant-id: ${{ secrets.SHELLHUB_TENANT_ID }}
       api-key: ${{ secrets.SHELLHUB_API_KEY }}
       authorize-actor: true
   ```

Authorized keys persist in the namespace (scoped to the tag) and are reused across
runs; remove them in ShellHub when no longer needed.

## Requirements

- The runner needs Docker (default on GitHub-hosted `ubuntu-*` runners).
- The API key needs the device accept and remove permissions in the namespace.
- Namespace **auto-accept can be off**: the action accepts the device itself.

## Security notes

The API key can accept and remove any device in the namespace. Scope it to a
dedicated key and rotate it. A future version will replace it with GitHub OIDC,
so no ShellHub secret is stored in the repo.

On hard job cancellation the post step may not run, leaving the device behind
(soft-deleted). A server-side reaper of stale ephemeral devices is the planned
authoritative cleanup.
