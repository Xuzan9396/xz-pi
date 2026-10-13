# xz-pi-usage

Show subscription quota windows, reset times, and Copilot AI credits for the physical account actually serving Pi's selected model.

## Install

From this repository:

```bash
pi install ./xz-pi-usage
```

Run `/reload` or restart Pi after installation. When Pi is started in a Herdr
pane, the same extension automatically publishes that pane's selected model
and serves Herdr's usage-refresh requests. **No second Pi package or bridge
installation is required.** It does not import any Herdr plugin code; outside
Herdr panes the adapter is inactive.

## Usage

- The compact footer keeps Pi's path, branch, context, physical provider, model, thinking level, and extension statuses, but removes cumulative token/cache/cost statistics. The selected physical Provider directly determines quota attribution; no sibling account is guessed or selected automatically. The current account's quota uses compact Unicode symbols (not official brand logos). For example `◎p wk95% 6d0h · ↻3` means Codex personal has 95% of its seven-day window remaining, resets in 6 days, and has 3 available rate-limit reset credits. `◎w` means Codex work; Copilot's `◆ 1.6K已用 · ↻2d8h` means about 1,600 AI credits **used**, resetting in 2 days 8 hours. Other symbols: `✦` Claude, `☾` Kimi, `𝕏` Grok, `◇` GLM, `▣` MiniMax.
- Window percentages are **remaining**, not used, in both the footer and `/xz-usage`. The detailed command labels seven-day windows as `week` (for example, `week 87%`). Credits without a known limit display the used count, not an invented remaining percentage. If the current provider has no available usage, this plugin shows no footer status.
- `/xz-usage` dynamically reads every provider present in Pi's `auth.json`, regardless of the current model, and resolves named accounts through `xz-pi-login`'s `config/xz-pi-login/accounts.json`. Providers follow their `auth.json` order. Accounts without a known subscription-usage endpoint remain visible with an unsupported message; new, removed, or remapped accounts are reflected on the next refresh.
- Native `openai` and named `openai-*` providers do not expose subscription usage directly. A named provider therefore maps only to a same-suffix Codex login (`openai-xuzan` → `openai-codex-xuzan`) and reuses that account's quota window under the active provider's label. It never guesses another account, and Codex-only reset credits are not copied into the OpenAI provider footer. If no exact companion exists, the dashboard explains the missing mapping and the footer remains hidden.
- Codex rate limit resets show the available count and each reset's expiry time.
- `/xz-usage --refresh` bypasses the five-minute cache.

The footer refreshes every five minutes. Model selection changes which existing physical account record is displayed; they do not trigger an extra quota request on every model request. `/reload` clears the displayed cache and waits for one forced refresh, so stale provider data is not carried into the reloaded extension runtime. Pi sessions share one cache and one cross-process lock, so only one refresh request runs at a time.

Other Pi extensions can request a refresh through the generic `pi.events`
interface: emit `xz-pi-usage:refresh-request` with `{ id: "unique-request-id", force: true }`.
This extension emits `xz-pi-usage:refresh-result` with the same `id` and
`status: "ok"` or `status: "error"` (`error` is a generic non-secret message).
Requests require an active Pi session; callers should handle absent responses
and timeouts. The API remains available to other Pi extensions; the bundled
Herdr adapter calls the existing refresh function directly. No dependency on
the Herdr plugin is introduced.

## Providers

Verified in this release:

- OpenAI Codex, including `openai-codex-personal` and `openai-codex-work`
- GitHub Copilot

Included but unverified: Claude, Kimi, Grok, GLM, and MiniMax. Their results are marked `未验证`.

Copilot token-based billing may report used AI credits without an entitlement. In that case the plugin shows only the used amount and never invents a percentage.

## Cache and security

Cache path: `~/.pi/agent/xz-pi-usage/cache.json`.

The cache has owner-only permissions and stores only normalized provider IDs, names, plans, windows, credits, reset times, statuses, and fetch times. It does not store tokens, raw responses, account names, or organization names.

The provider quota endpoints are undocumented and may change. Requests use timeouts, reject redirects, and cap response size.
