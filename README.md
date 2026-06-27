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
| `tags` | no | `ci` | Comma-separated tags for access scoping |
| `detached` | no | `false` | Continue the job instead of blocking |
| `timeout` | no | `0` | Max seconds to block (0 = indefinite) |
| `agent-version` | no | server's version | Pin the agent version |
| `install-url` | no | `<server>/install.sh` | Override the install script URL |

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
