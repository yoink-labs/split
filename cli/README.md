# Split CLI and MCP

Install the Node CLI from the Yoink Labs tap (or, from a checkout, `npm install -g ./cli`). Homebrew installs Node and links the launcher. The macOS file-splitting utility is available by its full path, `/usr/bin/split`.

```sh
brew install yoink-labs/tap/split
split --version
split login
split auth status --json
split groups list --json
```

Approve the computer on the web under **AI & CLI → Manage access** (account menu, bottom of the sidebar) or in the iPhone app under **You → Connected computers**: enter the terminal code, review the computer name and approve. Both places list connected computers and revoke them. Codes expire after ten minutes. The browser page at `https://split-api.yoinklabs.dev/device` gives the same instructions. Use `split login --no-open --name "Office Mac"` for a headless terminal.

Split stores the server origin and device token in an owner-only `~/.config/split/credentials.json` (or `$XDG_CONFIG_HOME/split/credentials.json`). The Worker stores a hash and checks revocation on every request. Use the app’s Connected computers screen to see last use or revoke a lost computer. To disconnect the current credential run `split logout` for a preview, then `split logout --yes`.

For automation, supply a device credential through your secret manager as `SPLIT_TOKEN`. `SPLIT_API_URL` defaults to `https://split-api.yoinklabs.dev`. Saved credentials are scoped to the issuing origin. Authenticate each machine separately to keep revocation independent.

## Commands

`split --help` lists commands. Each has `--json` and command-specific help, such as `split expenses edit --help`. JSON results go to stdout. Login instructions, confirmation previews during a write and errors go to stderr. Quote JSON arrays in your shell. Group, member and expense IDs come from list or create results.

```sh
split groups create --name Weekend --self Alex --kind trip --currency USD --placeholders '["Maya"]'
split groups show --group "$GROUP"
split members list --group "$GROUP"
split members add --group "$GROUP" --name Casey --email casey@example.com
split friends request --email casey@example.com
split friends list
split members known
split members invite --group "$GROUP" --user "$USER_ID"
split invitations list
split invitations accept --invitation "$INVITATION_ID"
split profile discoverable --discoverable off
split members add --group "$GROUP" --name Casey --user "$USER_ID"
split invite --group "$GROUP"                    # general invitation
split invite --group "$GROUP" --member "$MAYA"   # claim Maya’s placeholder
split invite --group "$GROUP" --member "$MAYA" --email maya@example.com
split invite --group "$GROUP" --name Jordan --email jordan@example.com
split members update --group "$GROUP" --member "$MAYA" --email maya.new@example.com
split members update --group "$GROUP" --member "$MAYA" --email none
split join --invite "$INVITE"                    # link or code
```

Exact email and username searches find existing Split users. Partial names match people with a shared group. Use `invite --member` for someone already on the roster or `invite --name` to create a new placeholder. Share the returned link or code with the individual yourself.

An email on a placeholder lets the owner of that verified primary email claim the member’s history when they open Split on the web or iOS. If they already joined separately, Split merges the placeholder history into their membership. CLI users can claim a placeholder with `split join --invite`. Changing or clearing the address revokes the placeholder’s existing invite links. Account holders manage their own sign-in email through Clerk.

```sh
split expenses add --group "$GROUP" --title Dinner --payer "$ALEX" --amount 24.50
split expenses add --group "$GROUP" --title Tickets --payer "$ALEX" --amount 30 \
  --mode exact --participants '["member-alex","member-maya"]' --values '["10.00","20.00"]'
split expenses add --group "$GROUP" --title Cab --payer "$MAYA" --amount 10.01 \
  --mode percent --participants '["member-alex","member-maya"]' --values '["25","75"]'
split expenses list --group "$GROUP"
split balances --group "$GROUP"
split balances --group "$GROUP" --member "$MEMBER"   # Signed balance breakdown
split settle up --group "$GROUP" --from "$MAYA" --to "$ALEX" --amount 7.50
split activity --group "$GROUP"
```

Replace sample IDs with the IDs in your group. Enter money as decimal major units. Responses use integer minor units, so USD 24.50 appears as `2450`. Balances stay separate by currency. Equal splits default to every member. For exact and percent splits, supply values in participant order. Use `settle up` to request approval for a payment you made or to record a payment you received. Payments you received are confirmed when you record them. Pending requests appear in `activity` for the payer and recipient and enter the ledger once approved.

Use `groups create --kind trip --start YYYY-MM-DD --end YYYY-MM-DD` for a scheduled trip or `--kind home` for an ongoing group. Use `groups update --kind` to change the type. In a trip, `expenses add` and `expenses edit` accept `--phase pre|during|post` to override the date-based phase. On edit, `--phase auto` restores the automatic phase. Use the same phase values with `expenses list` to filter the list. The matching MCP tools accept a `phase` argument.

The expense list includes the date, payer names and a `shortID` accepted by `expenses show`. Foreign expenses use a saved trip rate when available. To override it, pass the group currency per unit of expense currency, for example `--currency BRL --rate 0.18` in a USD group. Without either rate, the result warns that the expense uses a separate balance. The `exchange` object records the rate, source and rate date. Imported expenses keep their original transaction date. A rate provider can return an earlier published date on weekends or holidays.

Only the author can edit or delete an expense. Preview first. Pass the returned revision to commit that exact change. A stale revision fails. Edit previews show both expense states, including attached receipt photos and the recurrence schedule. Use `--json` for machine-readable output. A confirmed edit prints just the result. A confirmed deletion prints the preview to stderr. The `expenses add` and `expenses edit` help lists the case-sensitive category names.

```sh
split expenses edit --group "$GROUP" --expense "$EXPENSE" --title "Dinner for two"
split expenses edit --group "$GROUP" --expense "$EXPENSE" --title "Dinner for two" --yes --revision "$REVISION"
split expenses delete --group "$GROUP" --expense "$EXPENSE"
split expenses delete --group "$GROUP" --expense "$EXPENSE" --yes --revision "$REVISION"
```

### Group and expense management

```sh
split groups create --name Lisbon --self Alex --start 2026-12-01 --end 2026-12-05 --description "Pastéis tour"
split groups update --group "$GROUP" --name "Lisbon 2026" --end none --simplify off
split groups archive --group "$GROUP"                       # --action restore
split groups leave --group "$GROUP"                         # preview, then --yes
split groups delete --group "$GROUP"                        # creator only, preview and revision
split groups delete --group "$GROUP" --yes --revision "$REVISION"
split members remove --group "$GROUP" --member "$JO"        # archive: keeps history, out of new splits
split members remove --group "$GROUP" --member "$JO" --mode delete   # only with no expenses
split members remove --group "$GROUP" --member "$JO" --mode restore
split invites list --group "$GROUP"
split invites revoke --group "$GROUP" --invite "$INVITE_ID"
split expenses add --group "$GROUP" --title Hotel --amount 300 --payer "$ALEX" \
  --payers '[{"member":"'$ALEX'","amount":"200.00"},{"member":"'$MAYA'","amount":"100.00"}]'
split expenses show --group "$GROUP" --expense "$EXPENSE"   # payers, splits, FX, items, photos, comments
split expenses like --group "$GROUP" --expense "$EXPENSE"
split comments add --group "$GROUP" --expense "$EXPENSE" --text "I had the wine"
split comments list --group "$GROUP" --expense "$EXPENSE"
split receipts add --group "$GROUP" --expense "$EXPENSE" --photo receipt.heic
split receipts get --group "$GROUP" --expense "$EXPENSE" --photo "$PHOTO_ID" --out receipt.jpg
split groups export --group "$GROUP" --out lisbon.csv                     # one row per expense
split groups export --group "$GROUP" --format summary --out summary.csv   # paid, share, net, transfers
split groups export --group "$GROUP" --format json --out lisbon.json      # everything
split settlements pending --group "$GROUP"
split settlements respond --group "$GROUP" --settlement "$PAYMENT" --action approve
split profile avatar --avatar preset:ocean
```

Use `--format` to select what an export file contains. With `--json --out`, the CLI writes the selected format to disk and prints a JSON object with the saved path.

To delete a group in a terminal, `--yes` prompts you to type its name. For scripts and MCP, pass the revision from the preview as well. A payment recipient can approve or decline it. The payer can cancel it while approval is pending.

For a foreign expense, pass `--charged-amount 24.37` to `split expenses add` or
`split expenses edit` to use the actual card total in the settlement currency.
Pass `--charged-amount none` on edit to return to rate conversion. MCP uses
`chargedAmount` for the same option.

### Importing Splitwise exports

The CLI uses the same CSV parser as the web importer. It accepts localized exports, friend exports, and files with multiple supported currencies.

```sh
split import splitwise --file trip.csv
split import splitwise --file trip.csv --me Harris --preview
split import splitwise --file trip.csv --me Harris
```

First find your name in the CSV. Use `--preview` to check the destination, dates, currencies, and how each person maps to a Split member. Pass `--group ID` to import into an existing group. Use `--mapping '{"Maya":"MEMBER_ID"}'` to link another person to a member in that group. Unmapped people become placeholders. If the preview suggests matches, review them and pass the ones you want in `--mapping`.

A single-file import prompts for confirmation in an interactive terminal. Pass `--yes` to confirm ahead of time. For scripts and MCP, run a preview, review it, then send the import without `preview` after confirmation.

Repeat `--file` to process several exports. The options apply to every file, so run separate commands if names, mappings, or destinations differ. Preview a batch with `--preview` before saving. Each file reports its own result and successful imports are saved independently.

## Shared group settings

```sh
split groups default split --group GROUP_ID --participants '["MEMBER_A","MEMBER_B"]' --weights '[2,1]'
split groups rate --group GROUP_ID --currency USD --rate 1039.5
split profile payment --methods '[{"platform":"Wise","handle":"@alex","preferred":true}]'
split members payment --group GROUP_ID --methods '[{"platform":"Venmo","handle":"alex-a"}]'
split members payment --group GROUP_ID --reset
split expenses repeat --group GROUP_ID --expense EXPENSE_ID --cadence monthly
split expenses handled --group GROUP_ID --expense EXPENSE_ID --state handled
split expenses add --group GROUP_ID --title Lunch --amount 12.00 --payer MEMBER_ID --currency USD --rate 1039.5
```

### Refunds, credits and pending expenses

```sh
split refunds add --group GROUP_ID --expense EXPENSE_ID --amount 30.00                 # in proportion to shares
split refunds add --group GROUP_ID --expense EXPENSE_ID --amount 33.33 --participants '["CAM_ID"]'
split refunds add --group GROUP_ID --amount 10.00 --receiver ALEX_ID --participants '["BEA_ID"]' --title Overcharge
split expenses add --group GROUP_ID --title Excursion --amount 100.00 --payer MEMBER_ID --pending --pendingNote "Cam may get a refund"
split expenses pending --group GROUP_ID --expense EXPENSE_ID --note "Waiting on the ticket refund"
split expenses resolve --group GROUP_ID --expense EXPENSE_ID --action confirm
split expenses resolve --group GROUP_ID --expense EXPENSE_ID --action adjust --amount 66.67
split expenses resolve --group GROUP_ID --expense EXPENSE_ID --action refund --amount 33.33 --participants '["CAM_ID"]'
```

A refund lowers the balance of whoever received the money and raises the balance of each person credited. A refund of an expense cannot exceed its amount or any one person's share. Pending expenses count toward balances; `balances` also returns `confirmedNet` and the pending entries so you can see the balance without them, and `settle up` warns while entries are pending. See [docs/REFUNDS_AND_PENDING.md](../docs/REFUNDS_AND_PENDING.md).

Exchange rates use group currency units per one unit of foreign currency. Pass `--rate none` to clear the trip rate. Account payment methods apply to groups without an override. `members payment --reset` restores the account methods for that group. `expenses handled` keeps an expense in spending and export totals and removes it from outstanding balances and suggested transfers. The matching MCP tools use underscores in place of spaces.

## Receipts, claims and spending

Connected MCP clients discover the same receipt tools from the Worker, including through a local `split mcp` bridge.

```sh
split groups breakdown --group GROUP_ID
split groups breakdown --group GROUP_ID --member MEMBER_ID
split items open --group GROUP_ID
split items list --group GROUP_ID --expense EXPENSE_ID
split items claim --group GROUP_ID --expense EXPENSE_ID --item ITEM_ID
split items claim --group GROUP_ID --expense EXPENSE_ID --item ITEM_ID --member MEMBER_ID --share 0.5
split items assign --group GROUP_ID --expense EXPENSE_ID --item ITEM_ID --participants '["A","B"]' --shares '[2,1]'
split items claim --group GROUP_ID --expense EXPENSE_ID --item ITEM_ID --member MEMBER_ID --action remove
split items close --group GROUP_ID --expense EXPENSE_ID --participants '["MEMBER_ID"]'
split receipts list --group GROUP_ID --expense EXPENSE_ID
split receipts get --group GROUP_ID --expense EXPENSE_ID --photo PHOTO_ID
split receipts upload --group GROUP_ID --photo receipt.jpg --note "Taxi"   # to the group inbox
split receipts inbox --group GROUP_ID
split receipts pair --group GROUP_ID --photo RECEIPT_ID --expense EXPENSE_ID
split receipts move --group GROUP_ID --expense EXPENSE_ID --photo RECEIPT_ID --to OTHER_EXPENSE_ID   # or --to inbox
split receipts delete --group GROUP_ID --photo RECEIPT_ID
split items report --group GROUP_ID [--member MEMBER_ID]   # who consumed what, with tax and tip
```

Claim defaults to adding yourself. Pass a group member ID to add a second claimant or act for a placeholder. Close defaults to everyone for the remaining purchases. Each group report keeps currencies separate, includes member expense IDs, and returns full expense detail when filtered by member. The CLI returns JPEG content as base64 JSON. MCP returns JPEG image content. Take or select and review receipt photos in the iOS app. `expenses add` accepts a category and equal, exact, percent or shares allocation.

### Upload a receipt from an assistant

An assistant that can read the photo can record the whole receipt in one command. Items with `memberIDs` are assigned on upload; items without them stay open for the group to claim. `shares` are multipliers in `memberIDs` order, so `[2,1]` means the first person had two of three. `--photo` accepts JPEG, HEIC or PNG (up to four) and converts and shrinks each to the 240 KiB JPEG limit. A receipt closes automatically once every item is assigned. Unassigning an item reopens it, and the payer can still run `items close` to assign the remaining items.

Homebrew installs ImageMagick with Split. If you installed the CLI another way, install [ImageMagick with HEIC support](https://imagemagick.org/download/) and make sure `magick` is on PATH. Linux also supports the ImageMagick 6 `convert` command, and macOS can fall back to the built-in `sips` command. On Windows, run `node bin/split` from the extracted CLI directory.

```sh
split expenses add --group GROUP_ID --payer MEMBER_ID --title "Don Julio" --date 2026-11-14 \
  --photo receipt.heic \
  --bill '{"items":[{"title":"Malbec","amount":"48.00","memberIDs":["A","B","C"]},{"title":"Empanadas","amount":"18.00","memberIDs":["A","D"],"shares":[2,1]},{"title":"Flan","amount":"12.00"}],"tax":"14.00","tip":"28.00"}'
```

`items list` returns every item with its ID, gross amount including tax and tip, claimants and shares. `items assign` replaces an item's claimants in one call; `items claim --share` adds one person with a partial share.

## MCP clients

Sign in on the computer running the client. Use the absolute path from `command -v split` and verify it with `--version`. Desktop clients may otherwise find the macOS utility. The examples below use the default Apple silicon Homebrew path.

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`) accept the same stdio configuration.

```json
{
  "mcpServers": {
    "split": {
      "command": "/opt/homebrew/bin/split",
      "args": ["mcp"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.split]
command = "/opt/homebrew/bin/split"
args = ["mcp"]
```

**Claude Code**: `claude mcp add split -- "$(command -v split)" mcp`.

Restart the client and request `groups_list`. Through the local `split mcp` server, `photos` may be absolute file paths. The bridge converts HEIC/PNG and shrinks them before upload. For `expenses_edit`, `expenses_delete`, and `groups_delete`, show the user the preview, then send `yes: true` and its `revision` after confirmation.

**Remote MCP** uses Streamable HTTP at `https://split-api.yoinklabs.dev/mcp`. Create a token in **AI & CLI → Manage access** in the Split web app. Configure the client to send `Authorization: Bearer <token>`. Revoke the token from the same page. For example, Codex can read the token from its process environment.

```toml
[mcp_servers.split]
url = "https://split-api.yoinklabs.dev/mcp"
bearer_token_env_var = "SPLIT_TOKEN"
```

Choose one transport per server entry. The Worker handles each request independently with JSON responses. Stdio forwards MCP messages to that endpoint and reads the same credentials as the CLI.

## Build and release

From a checkout use `cli/bin/split`. The launcher lives under `cli/bin` so it can coexist with the `Split/` app directory on case-insensitive macOS volumes.

Changes to the CLI or its package on `main` trigger a patch release after the CLI tests pass. The workflow tags the source commit, embeds that version in the tarball, publishes it to Split and the Homebrew tap, and updates the formula with its SHA-256. For a planned minor or major release, set the matching version in `cli/release/version.json` and `cli/package.json` before merging.

The Split repository Actions secret `HOMEBREW_TAP_TOKEN` grants Contents write access to `yoink-labs/homebrew-tap`. To retry publishing a release, run **Release Split CLI** with its existing `split-vX.Y.Z` tag. The workflow verifies previously uploaded assets byte for byte and keeps the newest Homebrew formula in place.

```sh
node --test cli/test/*.test.mjs
npm ci --prefix worker
npm test --prefix worker
npm run typecheck --prefix worker
```

## Source and contributing

The CLI is part of the open-source [Split repository](https://github.com/yoink-labs/split) (MIT). Run it from a checkout with `cli/bin/split`, and run its tests with `node --test cli/test/*.test.mjs`. See [CONTRIBUTING.md](../CONTRIBUTING.md).


### Combine or restore expenses

Use expense IDs from `split expenses list --group GROUP` or matching rides from
`split expenses suggestions --group GROUP`. Combine expenses in the same
currency and preserve every recorded payer and receipt photo.

```sh
split expenses combine --group GROUP --expenses '["FIRST","SECOND"]'
split expenses uncombine --group GROUP --expense COMBINED
split expenses combination activity --group GROUP
```

The default is an equal split among active group members. Use `--participants`
to choose who shares and `--mode` and `--values` for a custom allocation.
The CLI shows the combined expense and asks before saving. Use `--dry-run` to
show the preview only, or `--yes` (`-y`) to save without a prompt. Use one of those
flags when stdin is redirected. The saved summary includes the new ID, and
`--json` returns the full expense.

In MCP, call `expenses_combine` to preview, then repeat with `yes: true` and the
preview's `revision` to save. MCP also exposes `expenses_uncombine`,
`expenses_suggestions`, and `expenses_combination_activity`.
