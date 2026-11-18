# Contributing to Split

Thanks for helping improve Split. Bug reports, small fixes and focused feature pull requests are welcome.

## Before you start

- Search existing issues and pull requests first. For a larger change, open an issue to agree on the approach before writing code.
- Report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Development

The [README](README.md#local-development) covers setup for the SwiftUI app, the Cloudflare Worker and the CLI. Copy `worker/.env.example` to `worker/.dev.vars` (or export the variables) for a local Worker, and `cli/.env.example` if you want to point the CLI elsewhere. Never commit real credentials.

Before opening a pull request, run:

```sh
npm ci --prefix worker
npm run typecheck --prefix worker
npm test --prefix worker
node --test cli/test/*.test.mjs
```

For app changes, also build and test the `Split` scheme in Xcode.

## Pull requests

- Keep each pull request to one change and describe what it does and how you tested it.
- Money is stored in integer minor units. Keep allocations exact to the cent.
- If you adapt code from another project, it must use a compatible license (MIT, Apache 2.0, BSD). Add it to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with the upstream revision and keep its license text in `docs/licenses/`.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
