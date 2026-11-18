# Third-party notices

Split is licensed under the [MIT License](LICENSE). Split adapts the following permissively licensed work. The linked license files retain the upstream notices. Changes in Split include Swift implementations, integer-cent accounting, authenticated D1 writes, deterministic import IDs and integration with Split group identities.

| Project and revision | Use in Split | License and copyright |
| --- | --- | --- |
| [ManaWG](https://github.com/Abuarchiv/manawg/tree/57cf9989e0667daa82416ab4827f269358236c85/apps/web/src/features/expenses) | Adapted the Splitwise net-column recovery and CSV format detection for Split’s Swift importer. Split rejects ambiguous allocations and preserves original currencies. | [Apache License 2.0](docs/licenses/manawg.txt) |
| [ShareTab](https://github.com/sw-carlos-cristobal/sharetab/tree/3c3cc4b483bd91e004c48408f871d8e1d7bb0555) | The amount-ordered settlement fallback follows ShareTab’s stable debtor and creditor ordering. Adapted the receipt claim draft model to merge changed selections by stable member ID. | [MIT](docs/licenses/sharetab.txt), copyright 2025–2026 ShareTab Contributors |
| [Spliit](https://github.com/spliit-app/spliit/blob/f293974bb3f0da063c1ced76a4abeb48eddee1e3/src/lib/recurrence.ts) | Adapted UTC recurrence with anchored month-end and leap-year handling for the Worker. | [MIT](docs/licenses/spliit.txt), copyright 2023 Sebastien Castiel |
| [Split Pro](https://github.com/oss-apps/split-pro/blob/7f48b6615944859869ca3bf25f4abc1671047413/src/lib/defaultSplit.ts) | Group split defaults and per-member weights informed Split’s shared defaults. | [MIT](docs/licenses/split-pro.txt), copyright 2024 OSS Apps |

Agent design guidance (instructions for coding agents, not shipped in the app) is vendored under `.agents/skills/`:

| Project and revision | Use in Split | License and copyright |
| --- | --- | --- |
| [anthropics/skills `frontend-design`](https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/frontend-design) | Web design direction for the 0.7 UI consistency pass. Copied unmodified to `.agents/skills/frontend-design/`. | [Apache License 2.0](docs/licenses/anthropic-frontend-design.txt), © Anthropic |
| [twostraws/SwiftUI-Agent-Skill `swiftui-pro`](https://github.com/twostraws/SwiftUI-Agent-Skill/tree/f2920b63995263f57b3e198674e89a602efba6d2/swiftui-pro) | SwiftUI and Apple Human Interface Guidelines review rules (design tokens, 44 pt targets, `ContentUnavailableView`, toolbar labels). `SKILL.md` and `references/` copied unmodified to `.agents/skills/swiftui-pro/`. | [MIT](docs/licenses/swiftui-pro.txt), copyright 2026 Paul Hudson |

Historical exchange-rate data comes from [Frankfurter v2](https://frankfurter.dev/). Argentine peso lookups request the Banco Central de la República Argentina provider. Each converted expense retains its source and effective date.

The web client uses React, React DOM, Scheduler and React Router under MIT licenses. Clerk hosts the MIT-licensed ClerkJS sign-in client. The browser distribution includes the applicable [web notices](web/public/NOTICE.txt).
