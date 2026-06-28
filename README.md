# ShellHub CI Debug Action

SSH into a live CI runner to debug a failing build, through ShellHub. Works with
[ShellHub Cloud](https://cloud.shellhub.io) or your own self-hosted instance, set
by the `server` input.

The session goes through your ShellHub gateway, so access is governed by your
namespace RBAC (roles and per-key/per-tag scoping), the session is recorded, and it
authenticates with keys you manage centrally. No session URL is printed to public
logs.

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

By default the job blocks at this step waiting for you to connect, then holds
until you disconnect. Run `sudo touch /continue` inside the session to release it
early. Connection state is read from the runner's `/dev/pts` (each session gets a
PTY), so it releases a few seconds after you disconnect, even if the connection
drops.

The job log prints the `ssh` command. The agent runs as root and can open a shell
as any host user, so connect as whichever you need (`root`, the job user, etc.):

```
ssh <user>@<namespace>.ci-<run_id>-<attempt>@cloud.shellhub.io
```

Set `ssh-username` to pin a single user and have it filled into the printed command.

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
| `authorize-actor` | no | `false` | Authorize the triggering user's GitHub keys (`true` requires them, `auto` is best-effort) |
| `ssh-username` | no | `.*` | Username (regexp) the authorized key may log in as; pin one to lock it down and show it in the SSHID |
| `detached` | no | `false` | Continue the job instead of blocking |
| `timeout` | no | `0` | Blocking mode: seconds to wait for a connection (then holds until you disconnect; 0 = wait indefinitely) |
| `idle-timeout` | no | `0` | Detached mode: seconds the post step waits for a connection at job end (then holds until disconnect; 0 = tear down immediately) |
| `agent-version` | no | server's version | Pin the agent version |
| `install-url` | no | `<server>/install.sh` | Override the install script URL |

## Outputs

| Output | Description |
|--------|-------------|
| `sshid` | The device SSHID without the username (`<namespace>.<device>@<host>`) |
| `ssh-command` | The full `ssh` command, including the resolved username |
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

A key you pass to the action (`public-key` or `authorize-actor`) is an ephemeral
grant: the action authorizes it for the run and removes it on teardown. A key you
register in ShellHub yourself (option 1) is left untouched and persists. The API
key therefore also needs the public key remove permission.

## Requirements

- The runner needs Docker (default on GitHub-hosted `ubuntu-*` runners).
- The API key needs device accept/remove and, when authorizing keys, public key
  create/remove permissions (an administrator or owner key has these).
- Namespace **auto-accept can be off**: the action accepts the device itself.
