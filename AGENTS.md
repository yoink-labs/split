# Agent guide

This is a Yoink Labs repo. Before touching the backend, auth, email,
analytics, payments, secrets, deploys or anything that could cost money, read
[`.agents/skills/yoink-labs/SKILL.md`](.agents/skills/yoink-labs/SKILL.md).
It explains what Yoink Labs is, the shared stack, naming, secret names and
the deploy and cost rules. App-specific details are in the README.

Split specifics:

- Money is integer minor units (cents). Allocations use largest remainder and
  must stay exact to the cent; never use floating point for amounts.
- The Worker in `worker/` is the security boundary. Every query checks group
  membership; add a Worker test for any new route or permission.
- `project.yml` is the source of truth for the Xcode project. Run
  `xcodegen generate` after adding files.
- Code adapted from another project must be MIT, Apache 2.0 or BSD and listed
  in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with its license text in
  `docs/licenses/`.
- Before a PR: `npm run typecheck --prefix worker`, `npm test --prefix worker`
  and `node --test cli/test/*.test.mjs`. See [CONTRIBUTING.md](CONTRIBUTING.md).
