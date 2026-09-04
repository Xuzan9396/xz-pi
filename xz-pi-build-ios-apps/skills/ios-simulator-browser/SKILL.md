---
name: ios-simulator-browser
description: Mirror an iOS Simulator into a browser and render SwiftUI previews from importable Swift packages with hot reload. Use when a user wants to watch or interact with an iOS app in a browser, see a SwiftUI preview outside Xcode Canvas, iterate live on a preview, or capture browser-visible simulator proof.
---

# iOS Simulator Browser

## Browser Workflow

1. Obtain an explicit Simulator UDID from the existing iOS build/run workflow or from `xcrun simctl list devices available`.
2. Start the pinned `serve-sim` version in a long-running foreground terminal or visible `tmux` pane. Pin it to that simulator, clean up only the tracked helper for the same UDID before starting, and install a trap so cleanup runs when the terminal exits:

   ```bash
   SIM="<simulator-udid>"
   cleanup_serve_sim() {
     npx --yes serve-sim@0.1.46 --kill "$SIM" >/dev/null 2>&1 || true
   }
   trap cleanup_serve_sim EXIT INT TERM HUP
   cleanup_serve_sim
   npx --yes serve-sim@0.1.46 "$SIM"
   ```

3. Read the exact local preview URL printed by `serve-sim`.
4. Open that URL using an available Pi browser automation tool. If no browser tool is loaded, open it in the default macOS browser:

   ```bash
   open "<exact-local-preview-url>"
   ```

5. Verify that a real Simulator frame is rendering before reporting success. A browser page loading successfully is not proof that the stream is healthy.

- Keep the terminal or `tmux` pane alive while the mirror is in use.
- When finished, stop the foreground process and wait for the trap to complete.
- If the terminal disappeared or did not exit cleanly, run `npx --yes serve-sim@0.1.46 --kill "$SIM"` before starting another mirror for that simulator.
- Never run an unscoped `serve-sim --kill`; another process may own a different simulator mirror.
- Never replace the pinned version during a session without reviewing the newer package first.

## SwiftUI Preview Workflow

Use the bundled launcher when the requested previews live in an importable Swift package. Point it at the package manifest and select the target whose previews should be displayed. It generates a disposable host project outside the user's source tree, installs and launches that host in Simulator, and watches the package for edits.

```bash
node <skill-root>/scripts/swiftui-preview-browser.mjs \
  /absolute/path/to/Package.swift \
  --package-target "<target>" \
  --device "<simulator-udid>"
```

- Watch mode is enabled by default. On a Swift package source edit, the launcher rebuilds a generated dylib and hot-swaps it into the running host without relaunching the app.
- The generated host shows every preview variant discovered in the selected Swift Package target with in-simulator page controls.
- To show a subset, pass `--preview-filter <regex[, ...]>`; it matches display names and code identifiers such as `StatusRowView_Previews`.
- Once the launcher prints the selected Simulator UDID, start pinned `serve-sim` for that exact UDID and open its printed URL using the browser workflow above.

## Support Boundary

- Support Swift Package-backed `PreviewProvider` and `#Preview` declarations through the generated host.
- Do not edit the user's `.xcodeproj`, `.xcworkspace`, `Package.swift`, schemes, or build settings to force preview support.
- Keep generated hosts and build output outside the user's source tree.
- Do not boot a simulator or start a long-running mirror unless the user has requested the workflow.

## Proof

For browser or preview QA, save a browser screenshot showing the rendered Simulator frame when browser automation is available. Otherwise, capture simulator proof with the pinned XcodeBuildMCP CLI or ask the user to confirm the visible frame in the browser.

For hot reload QA, also report the launcher's `hot reloaded package preview ... in pid ...` output and show the changed frame after editing. Do not claim hot reload from a successful rebuild alone.
