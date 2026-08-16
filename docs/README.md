# Slim design docs

| Doc | What |
| --- | --- |
| [dx.md](./dx.md) | CLI surface, exit codes, stdout/stderr, Friday walkthrough, Actions, evidence, watch, v1 vs later |
| [help.txt](./help.txt) | Top-level `--help` (test snapshot) |
| [packages.md](./packages.md) | First-wave matrix, hardness, refuse errors |
| [repo.md](./repo.md) | Layout, slim.json fields, OSS hygiene, file inventory |
| [evidence.lodash.sample.md](./evidence.lodash.sample.md) | The 90-second report |
| [slim.schema.json](./slim.schema.json) | Config schema (seven fields) |
| [transcripts/friday-lodash.txt](./transcripts/friday-lodash.txt) | Magical moment, stdout/stderr |
| [samples/lodash.slice.js](./samples/lodash.slice.js) | Historical JS sketch; the Friday slice is TypeScript in `fixtures/lodash-get-debounce/` (~250 lines) |
| [examples/](./examples/) | User-repo GitHub workflows |

Core loop in v1: **envelope → generate → fuzz → PR → standing tests → watch**. No SaaS. No billing.
