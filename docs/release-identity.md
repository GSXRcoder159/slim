# Release identity

Approved GitHub and published Action identity. The first publishable npm name and version remain a Phase 17 decision: `slim@0.1.0` is occupied on the public registry by an unrelated package.

| Field | Value |
| --- | --- |
| GitHub owner/repository | `GSXRcoder159/slim` |
| Visibility | public |
| Default branch | `main` |
| Git URL | `git+https://github.com/GSXRcoder159/slim.git` |
| Bugs | `https://github.com/GSXRcoder159/slim/issues` |
| Homepage | `https://github.com/GSXRcoder159/slim#readme` |
| Advertised Action pin | `GSXRcoder159/slim/action/{check,bloat,upstream}@v1` |
| npm package name (current metadata) | `slim` |
| npm version (current metadata) | `0.1.0` |

Package metadata, documentation, examples, release identity checks, and Action receipts must use this GitHub identity. Dogfood workflows in this repository still run `npm run build` then `uses: ./action/*` because `dist/` is gitignored on the default branch. Published tags carry the compiled Action tree.

Standard GitHub-hosted runners on this public repository do not consume private-repo Actions minutes. Larger runners are not used.
