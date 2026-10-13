# Upstream provenance

`xz-pi-login` was initially derived from:

- Repository: https://github.com/AdityaVG13/pi-stack
- Package: `packages/pi-rotator`
- Commit: `86e85612952f85a0b90621cd97636fa30964a32c`
- Upstream package version: `0.5.2`
- License: MIT

The fork keeps the upstream MIT license and the Cursor-specific licenses,
notices, and provenance records. The main changes are:

- a standalone `/xz-login` command and `xz-pi-login` storage namespace;
- explicit persisted `{provider}-{alias}` account identities;
- removal of numbered-account discovery, legacy transport layering, and cutover;
- interactive alias input and managed-account removal selection;
- conflict-safe account-map updates using file locks and atomic replacement.

Cursor transport code remains covered by the license and notice files under
`lib/cursor/`. `PROVENANCE.json` pins the bytes shipped by this package.
