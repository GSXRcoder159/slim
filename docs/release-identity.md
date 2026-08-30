# Release identity

Approved GitHub, published Action, and npm identity. The CLI bin remains `slim`. Public `slim@0.1.0` on npm is an unrelated package and is not this product.

| Field | Value |
| --- | --- |
| GitHub owner/repository | `GSXRcoder159/slim` |
| Visibility | public |
| Default branch | `main` |
| Git URL | `git+https://github.com/GSXRcoder159/slim.git` |
| Bugs | `https://github.com/GSXRcoder159/slim/issues` |
| Homepage | `https://github.com/GSXRcoder159/slim#readme` |
| Advertised Action pin | `GSXRcoder159/slim/action/{check,bloat,upstream}@v1` |
| npm package name | `@gsxrcoder159/slim` |
| npm version | `0.1.0` |
| npm registry | `https://registry.npmjs.org` |
| Install | `npm i -g @gsxrcoder159/slim` then `slim`, or `npx @gsxrcoder159/slim` |
| unpkg `$id` prefix | `https://unpkg.com/@gsxrcoder159/slim/` |

Package metadata, documentation, examples, release identity checks, and Action receipts must use this identity. Dogfood workflows in this repository still run `npm run build` then `uses: ./action/*` because `dist/` is gitignored on the default branch. Published tags carry the compiled Action tree.

Release publishes only the tarball from a downloaded complete `qualification-bundle` (receipts stay gitignored). That artifact comes from a successful `qualify.yml` run for the same commit, not from the osNode-only CI seed bundle. `--workflow-run` is the CI run id recorded in `qualify-report.json`. The release job does not build or pack. `workflow_dispatch` rehearses by default (`rehearse=true`). Publish from dispatch is allowed only from `main`. Tag push publish requires the tag to equal `v${version}`.

Standard GitHub-hosted runners on this public repository do not consume private-repo Actions minutes. Larger runners are not used.
