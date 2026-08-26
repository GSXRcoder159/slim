# Changelog

## 0.1.0

First production CLI. Scan, inspect, replace, check, upstream/watch, and doctor. Catalog covers lodash (and aliases), moment format, uuid v4, ms, nanoid, clsx, whatwg-url, bluebird, and mime-types. LLM generation is optional and uses the same gates as catalog slices.

### Revert / migration

A Slim replacement is one git commit (or one PR). To undo:

1. `git revert` that commit, or
2. Restore the original package in `package.json`, delete `src/slim/<pkg>.ts` and standing tests, restore import specifiers listed in `.slim/<pkg>/evidence.md`, then `npm install`.

`--keep-original` leaves the dependency installed while still writing the slice. The original package is a CI-only oracle during `slim replace`; after a normal merge it is gone from the project.

Node 26 Current is not in CI until it is LTS. Minimum Node is 22.18. Active LTS 24 is tested.
