# Split CLI and MCP

Install the Node CLI from the Yoink Labs tap. Homebrew installs Node and links the launcher. The macOS file-splitting utility is available by its full path, `/usr/bin/split`.

```sh
brew install yoink-labs/tap/split
split --version
split login
split auth status --json
split groups list --json
```

Open **You → Connected computers** in the signed-in Split iPhone app, enter the terminal code, review the computer name and approve. Use an app build containing Connected computers. Codes expire after ten minutes. The browser page at `https://split-api.yoinklabs.dev/device` gives the same instructions. Use `split login --no-open --name "Office Mac"` for a headless terminal.

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
split join --invite "$INVITE"                    # link or code
```

Exact email and username searches find existing Split users. Partial names match people with a shared group. A targeted invitation keeps the member’s existing expenses. Contact details and verified email claims follow the same rules as the app.

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

## Receipts, claims and spending

The current checkout includes the receipt commands below. Use `./cli/bin/split` from the repository root with Node 22.18+ to run the updated client. Connected MCP clients discover the same tools from the production Worker, including through an existing stdio bridge.

```sh
split groups breakdown --group GROUP_ID
split groups breakdown --group GROUP_ID --member MEMBER_ID
split items open --group GROUP_ID
split items claim --group GROUP_ID --expense EXPENSE_ID --item ITEM_ID
split items claim --group GROUP_ID --expense EXPENSE_ID --item ITEM_ID --member MEMBER_ID --action remove
split items close --group GROUP_ID --expense EXPENSE_ID --participants '["MEMBER_ID"]'
split receipts list --group GROUP_ID --expense EXPENSE_ID
split receipts get --group GROUP_ID --expense EXPENSE_ID --photo PHOTO_ID
```

Claim defaults to adding yourself. Pass a group member ID to add a second claimant or act for a placeholder. Close defaults to everyone for the remaining purchases. Each group report keeps currencies separate, includes member expense IDs, and returns full expense detail when filtered by member. The CLI returns JPEG content as base64 JSON. MCP returns JPEG image content. Take or select and review receipt photos in the iOS app. `expenses add` accepts a category and equal, exact, percent or shares allocation.

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

Restart the client and request `groups_list`. Both transports expose the same tools and validate the same schemas. For `expenses_edit` and `expenses_delete`, show the user the preview, then send `yes: true` and its `revision` after confirmation.

**Remote MCP** uses Streamable HTTP at `https://split-api.yoinklabs.dev/mcp`. Configure the client to send `Authorization: Bearer <device token>`. For example, Codex can read the token from its process environment.

```toml
[mcp_servers.split]
url = "https://split-api.yoinklabs.dev/mcp"
bearer_token_env_var = "SPLIT_TOKEN"
```

Choose one transport per server entry. The Worker handles each request independently with JSON responses. Stdio forwards MCP messages to that endpoint and reads the same credentials as the CLI.

## Build and release

From a checkout use `cli/bin/split`. The launcher lives under `cli/bin` so it can coexist with the `Split/` app directory on case-insensitive macOS volumes.

Update `cli/release/version.json`, merge to main, then tag the merge commit `split-vX.Y.Z`. The release workflow builds an allowlisted tarball, publishes it in both repositories and updates the public formula with its SHA-256. Configure the Split repository Actions secret `HOMEBREW_TAP_TOKEN` with Contents write access scoped to `yoink-labs/homebrew-tap`. The workflow can be rerun for an existing tag and verifies any previously uploaded asset byte for byte.

```sh
node --test cli/test/*.test.mjs
npm ci --prefix worker
npm test --prefix worker
npm run typecheck --prefix worker
```
