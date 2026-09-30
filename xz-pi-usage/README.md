# xz-pi-usage

Show subscription quota windows, reset times, and Copilot AI credits in Pi.

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

- The footer shows only the current model's provider, using compact Unicode symbols (not official brand logos). For example `◎p wk95% 6d0h · ↻3` means Codex personal has 95% of its seven-day window remaining, resets in 6 days, and has 3 available rate-limit reset credits. `◎w` means Codex work; Copilot's `◆ 1.6K已用 · ↻2d8h` means about 1,600 AI credits **used**, resetting in 2 days 8 hours. Other symbols: `✦` Claude, `☾` Kimi, `𝕏` Grok, `◇` GLM, `▣` MiniMax.
- Window percentages are **remaining**, not used, in both the footer and `/xz-usage`. The detailed command labels seven-day windows as `week` (for example, `week 87%`). Credits without a known limit display the used count, not an invented remaining percentage. If the current provider has no available usage, this plugin shows no footer status.
- `/xz-usage` queries and shows only supported providers present in Pi's `auth.json`, regardless of the current model. Providers follow their order in that file; unsupported or absent providers are skipped. New or removed auth entries are reflected on the next refresh.
- Codex rate limit resets show the available count and each reset's expiry time.
- `/xz-usage --refresh` bypasses the five-minute cache.

The footer refreshes every five minutes. Pi sessions share one cache and one cross-process lock, so only one refresh request runs at a time.

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
