# Changesets

Run `npm run changeset` after changing a publishable package. Select the affected package and a SemVer bump (`patch`, `minor`, or `major`), then commit the generated Markdown file.

On `main`, the release workflow maintains a version PR. Merging that PR publishes only packages whose versions changed.
