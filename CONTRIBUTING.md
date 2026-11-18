# Contributing to Split

We love PRs. We need PRs. Split only gets built if people help, and we handle
the boring parts (servers, the App Store, keys and bills) so you can focus on
the app. Tell us what you need, or just ship it.

## Find something to work on

- [Good first issues](https://github.com/yoink-labs/split/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
  are small and well scoped.
- [Help wanted](https://github.com/yoink-labs/split/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22)
  are bigger pieces we'd love a hand with. Issues are also labeled by area:
  `ios`, `web`, `cli` and `worker`.
- [ROADMAP.md](ROADMAP.md) lists what is shipped, in progress and planned.
  Anything under **Planned** is fair game.
- Questions and ideas go in [Discussions](https://github.com/yoink-labs/split/discussions).

For anything bigger than a bug fix, open an issue first so we can agree on the
approach before you spend a weekend on it. Comment on an issue to claim it.

## Set up

You don't need any of our accounts or keys. The README's
[Contributing section](README.md#contributing) has the full walkthrough. Short
version, on a Mac with Xcode, [XcodeGen](https://github.com/yonaskolb/XcodeGen)
and Node 22:

```bash
npm ci --prefix worker
xcodegen generate
open Split.xcodeproj        # run the Split scheme, then tap "Take a look around"
```

The signed-out sample preview runs entirely on the device, so most app work
needs no backend at all. For Worker or CLI work, run a local Worker with
`wrangler dev` (see the README).

## Run the tests

```bash
npm run typecheck --prefix worker
npm test --prefix worker
node --test cli/test/*.test.mjs
```

App changes: build and test the `Split` scheme in Xcode, or

```bash
xcodebuild test -project Split.xcodeproj -scheme Split \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

CI runs the Worker and CLI checks on every pull request, including PRs from
forks. It needs no secrets.

## Pull requests

- Keep each PR to one change, and say what it does and how you checked it.
- Add or update tests for logic changes (`SplitTests`, `worker/test`,
  `cli/test`).
- Money is stored in integer minor units. Keep allocations exact to the cent.
- For UI changes, include a screenshot or short recording, and check light
  mode, dark mode and a large Dynamic Type size.
- Edit `project.yml`, not the generated Xcode project, when you add files or
  settings, then run `xcodegen generate`.
- Database changes are new numbered files in `worker/migrations/`. Never edit
  a migration that has already merged.
- Never commit secrets. `.env*` and `.dev.vars*` are gitignored for a reason;
  only publishable keys and URLs belong in the app.
- If you adapt code from another project, it must use a compatible license
  (MIT, Apache 2.0, BSD). Add it to
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with the upstream revision
  and keep its license text in `docs/licenses/`.
- Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for
  anything a user would notice.

## What we won't merge (for now)

- Paid APIs or services that cost money per user. Free, keyless services only
  (exchange rates come from Frankfurter).
- Moving money. Split records payments; it doesn't transfer funds.
- Paywalls. Features that cost us nothing stay free.

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md),
not in a public issue.

## Licensing

Split is MIT licensed. See [LICENSE](LICENSE). By contributing, you agree that
your contributions are licensed under the same license.

## Be kind

Everyone here follows our [Code of Conduct](CODE_OF_CONDUCT.md). Assume good
intent, review the code rather than the person, and help newcomers get their
first PR in.
