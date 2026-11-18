# Split roadmap

Split is a free shared-expense tracker from [Yoink Labs](https://yoinklabs.dev).
There is no paywall, no Pro tier and no subscription, and every feature
below is free.

This page only lists work that exists in the repo or is written down in it.
There are no dates. For what changed in each release, see
[CHANGELOG.md](CHANGELOG.md). Want to help? Pick anything under **Planned**,
or look for [good first issues](https://github.com/yoink-labs/split/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
and [help wanted](https://github.com/yoink-labs/split/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22).

## Shipped

- **iOS app, public beta on
  [TestFlight](https://testflight.apple.com/join/YX8W6bCx).** SwiftUI,
  iOS 18+. Groups and two-person tabs, equal, exact, percentage and share
  splits, settle-up suggestions and recorded payments, and a signed-out sample
  preview ([#1](https://github.com/yoink-labs/split/pull/1)).
- **Joining and people.** Reusable group invites by link or code, placeholders
  that people can claim later, account lookup, editing and deleting entries
  ([#3](https://github.com/yoink-labs/split/pull/3)).
- **Receipts.** On-device receipt reading, shared item claims, and spending
  breakdowns by category, month and person
  ([#4](https://github.com/yoink-labs/split/pull/4)).
- **Group tools.** Settlement currency with historical or manual exchange
  rates, minimum-transfer settlement, CSV import from Splitwise, Splid,
  Settle Up and Tricount, CSV export, recurring expenses, default shares and
  payment links ([#5](https://github.com/yoink-labs/split/pull/5)).
- **CLI and MCP server**, installable with
  `brew install yoink-labs/tap/split`, plus remote MCP over HTTP
  ([#2](https://github.com/yoink-labs/split/pull/2)).
- **Backend on Cloudflare.** A Worker at `split-api.yoinklabs.dev` with D1,
  on free tiers (`worker/`).
- **Open source under MIT**
  ([#7](https://github.com/yoink-labs/split/pull/7)).

- **Member charges and web app.** Open a member, charge, receipt or another participant on iOS and the web. Join, claim and settle at [Split](https://split.yoinklabs.dev).

## In progress

- **Splitwise parity, Liquid Glass and iPhone Duo (0.5).** A home dashboard,
  friends, comments and likes, search, insights charts, multiple payers and
  archived groups ([#6](https://github.com/yoink-labs/split/pull/6),
  [plan](https://github.com/yoink-labs/split/blob/ade/splitwise-website-login/docs/SPLITWISE_PARITY.md)).

## Planned

Open items written down in the repo, in no particular order:

- **Refunds**: negative expenses that reverse part of an earlier cost.
- **Offline edits.** The offline queue covers new groups, expenses and
  payments; edits, claims and deletions still need a connection.
- **Spanish localization.**
- **Push reminders and monthly statements.**
- **More currencies.**
- **Bank import.**
- **CLI quality of life:** shell completions and human-readable output.
