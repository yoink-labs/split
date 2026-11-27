# Split CLI and MCP

Install the Node CLI from the Yoink Labs tap (or, from a checkout, `npm install -g ./cli`). Homebrew installs Node and links the launcher. The macOS file-splitting utility is available by its full path, `/usr/bin/split`.

```sh
brew install yoink-labs/tap/split
split --version
split login
split auth status --json
split groups list --json
```

Approve the computer on the web at **Connect AI & CLI** (account menu, bottom of the sidebar) or in the iPhone app under **You → Connected computers**: enter the terminal code, review the computer name and approve. Both places list connected computers and revoke them. Codes expire after ten minutes. The browser page at `https://split-api.yoinklabs.dev/device` gives the same instructions. Use `split login --no-open --name "Office Mac"` for a headless terminal.

Split stores the server origin and device token in an owner-only `~/.config/split/credentials.json` (or `$XDG_CONFIG_HOME/split/credentials.json`). The Worker stores a hash and checks revocation on every request. Use the app’s Connected computers screen to see last use or revoke a lost computer. To disconnect the current credential run `split logout` for a preview, then `split logout --yes`.

For automation, supply a device credential through your secret manager as `SPLIT_TOKEN`. `SPLIT_API_URL` defaults to `https://split-api.yoinklabs.dev`. Saved credentials are scoped to the issuing origin. Authenticate each machine separately to keep revocation independent.

## Commands

`split --help` lists commands. Each has `--json` and command-specific help, such as `split expenses edit --help`. JSON results go to stdout. Login instructions, confirmation previews during a write and errors go to stderr. Quote JSON arrays in your shell. Group, member and expense IDs come from list or create results.

```sh
split groups create --name Weekend --self Alex --kind trip --currency USD --placeholders '["Maya"]'
split groups show --group "$GROUP"
split members list --group "$GROUP"
split members add --group "$GROUP" --name Casey --email casey@example.com
split members lookup --query casey@example.com
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
split settle up --group "$GROUP" --from "$MAYA" --to "$ALEX" --amount 7.50
split activity --group "$GROUP"
```

Replace sample IDs with the IDs in your group. Enter money as decimal major units. Responses use integer minor units, so USD 24.50 appears as `2450`. Balances stay separate by currency. Equal splits default to every member. For exact and percent splits, supply values in participant order. Recording a settlement updates the ledger after a payment.

Only the author can edit or delete an expense. Preview first. Pass the returned revision to commit that exact change. A stale revision fails. The CLI also fetches and prints the current preview before each confirmed write.

```sh
split expenses edit --group "$GROUP" --expense "$EXPENSE" --title "Dinner for two"
split expenses edit --group "$GROUP" --expense "$EXPENSE" --title "Dinner for two" --yes --revision "$REVISION"
split expenses delete --group "$GROUP" --expense "$EXPENSE"
split expenses delete --group "$GROUP" --expense "$EXPENSE" --yes --revision "$REVISION"
```

### Everything the web app does

Every action in the web app has a command, so an assistant can run the whole group:

```sh
split groups create --name Lisbon --self Alex --start 2026-12-01 --end 2026-12-05 --description "Pastéis tour"
split groups update --group "$GROUP" --name "Lisbon 2026" --end none --simplify off
split groups archive --group "$GROUP"                       # --action restore
split groups leave --group "$GROUP"                         # preview, then --yes
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
split import splitwise --file export.csv                    # shows the names in the file
split import splitwise --file export.csv --me Harris        # new group; --group ID merges into one
split profile avatar --avatar preset:ocean
```

## Shared group settings

```sh
split groups default split --group GROUP_ID --participants '["MEMBER_A","MEMBER_B"]' --weights '[2,1]'
split members payment --group GROUP_ID --alias your.bank.alias
split expenses repeat --group GROUP_ID --expense EXPENSE_ID --cadence monthly
split expenses add --group GROUP_ID --title Lunch --amount 12.00 --payer MEMBER_ID --currency USD --rate 1039.5
```

The rate is in group currency units per one expense currency unit. Omit it to keep the original currency in CLI records. The iOS composer also looks up historical rates. Setting your payment profile replaces its previous values for this group. The matching MCP tools use underscores in place of spaces.

## Receipts, claims and spending

The current checkout includes the receipt commands below. Use `./cli/bin/split` from the repository root with Node 22.18+ to run the updated client. Connected MCP clients discover the same tools from the production Worker, including through an existing stdio bridge.

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
```

Claim defaults to adding yourself. Pass a group member ID to add a second claimant or act for a placeholder. Close defaults to everyone for the remaining purchases. Each group report keeps currencies separate, includes member expense IDs, and returns full expense detail when filtered by member. The CLI returns JPEG content as base64 JSON. MCP returns JPEG image content. Take or select and review receipt photos in the iOS app. `expenses add` accepts a category and equal, exact, percent or shares allocation.

### Upload a receipt from an assistant

An assistant that can read the photo can record the whole receipt in one command. Items with `memberIDs` are assigned on upload; items without them stay open for the group to claim. `shares` are multipliers in `memberIDs` order, so `[2,1]` means the first person had two of three. `--photo` accepts JPEG, HEIC or PNG (up to four) and, on macOS, converts and shrinks each to the 240 KiB receipt limit.

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

Restart the client and request `groups_list`. Through the local `split mcp` server, `photos` may be absolute file paths; the bridge converts HEIC/PNG and shrinks them before upload. Both transports expose the same tools and validate the same schemas. For `expenses_edit` and `expenses_delete`, show the user the preview, then send `yes: true` and its `revision` after confirmation.

**Remote MCP** uses Streamable HTTP at `https://split-api.yoinklabs.dev/mcp`. Configure the client to send `Authorization: Bearer <device token>`. For example, Codex can read the token from its process environment.

```toml
[mcp_servers.split]
url = "https://split-api.yoinklabs.dev/mcp"
bearer_token_env_var = "SPLIT_TOKEN"
```

Choose one transport per server entry. The Worker handles each request independently with JSON responses. Stdio forwards MCP messages to that endpoint and reads the same credentials as the CLI.

## Build and release

From a checkout use `cli/bin/split`. The launcher lives under `cli/bin` so it can coexist with the `Split/` app directory on case-insensitive macOS volumes.

Update `cli/release/version.json` and `cli/package.json`, then merge to main. The release workflow tags the merge commit `split-vX.Y.Z`, builds an allowlisted tarball, publishes it in both repositories and updates the public formula with its SHA-256. Configure the Split repository Actions secret `HOMEBREW_TAP_TOKEN` with Contents write access scoped to `yoink-labs/homebrew-tap`. The workflow can be rerun for an existing tag and verifies any previously uploaded asset byte for byte.

```sh
node --test cli/test/*.test.mjs
npm ci --prefix worker
npm test --prefix worker
npm run typecheck --prefix worker
```

## Source and contributing

The CLI is part of the open-source [Split repository](https://github.com/yoink-labs/split) (MIT). Run it from a checkout with `cli/bin/split`, and run its tests with `node --test cli/test/*.test.mjs`. See [CONTRIBUTING.md](../CONTRIBUTING.md).
