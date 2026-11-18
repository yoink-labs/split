# Third-party notices

Split adapts the following permissively licensed work. The linked license files retain the upstream notices. Changes in Split include Swift implementations, integer-cent accounting, authenticated D1 writes, deterministic import IDs and integration with Split group identities.

| Project and revision | Use in Split | License and copyright |
| --- | --- | --- |
| [ManaWG](https://github.com/Abuarchiv/manawg/tree/57cf9989e0667daa82416ab4827f269358236c85/apps/web/src/features/expenses) | Adapted the Splitwise net-column recovery and CSV format detection for Split’s Swift importer. Split rejects ambiguous allocations and preserves original currencies. | [Apache License 2.0](docs/licenses/manawg.txt) |
| [ShareTab](https://github.com/sw-carlos-cristobal/sharetab/tree/3c3cc4b483bd91e004c48408f871d8e1d7bb0555) | The amount-ordered settlement fallback follows ShareTab’s stable debtor and creditor ordering. Adapted the receipt claim draft model to merge changed selections by stable member ID. | [MIT](docs/licenses/sharetab.txt), copyright 2025–2026 ShareTab Contributors |
| [Spliit](https://github.com/spliit-app/spliit/blob/f293974bb3f0da063c1ced76a4abeb48eddee1e3/src/lib/recurrence.ts) | Adapted UTC recurrence with anchored month-end and leap-year handling for the Worker. | [MIT](docs/licenses/spliit.txt), copyright 2023 Sebastien Castiel |
| [Split Pro](https://github.com/oss-apps/split-pro/blob/7f48b6615944859869ca3bf25f4abc1671047413/src/lib/defaultSplit.ts) | Group split defaults and per-member weights informed Split’s shared defaults. | [MIT](docs/licenses/split-pro.txt), copyright 2024 OSS Apps |

Historical exchange-rate data comes from [Frankfurter v2](https://frankfurter.dev/). Argentine peso lookups request the Banco Central de la República Argentina provider. Each converted expense retains its source and effective date.
