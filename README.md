# id.org.ai — Claim by Commit

GitHub Action for claiming anonymous [headless.ly](https://headless.ly) tenants via GitHub identity.

Uses GitHub Actions OIDC tokens for authentication — no PATs or secrets required.

## Usage

```yaml
name: Claim headless.ly tenant
on:
  push:
    branches: [main, master]
permissions:
  id-token: write
  contents: read
jobs:
  claim:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dot-org-ai/id@v1
        with:
          tenant: 'clm_your_claim_token'
```

## How it works

1. An agent provisions an anonymous sandbox via `id.org.ai provision`
2. The agent runs `id.org.ai claim` which generates this workflow and pushes it
3. On push, the GitHub App webhook claims the tenant immediately
4. This action confirms the claim via OIDC and writes tenant config to `.headless.ly/tenant.json`

## Inputs

| Input | Description | Required |
|-------|-------------|----------|
| `tenant` | Claim token from provisioning (`clm_*`) | Yes |
| `sync-keys` | Sync agent public keys to `.headless.ly/agents/*.pub` | No (default: `false`) |

## Outputs

| Output | Description |
|--------|-------------|
| `tenant-id` | The claimed tenant ID |
| `level` | Capability level after claiming (typically 2) |
| `claimed` | Whether the claim succeeded (`true`/`false`) |

## Requirements

- Workflow must have `permissions: { id-token: write }` for OIDC
- The [id.org.ai GitHub App](https://github.com/apps/id-org-ai) must be installed on the repository

## License

MIT
