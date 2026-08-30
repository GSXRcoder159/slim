# Slim design docs

| Doc | What |
| --- | --- |
| [dx.md](./dx.md) | CLI surface, exit codes, stdout/stderr, Friday walkthrough, Hyrum substitution contract, Actions, evidence, watch, v1 vs later |
| [help.txt](./help.txt) | Snapshot of shipped `slim --help` (`src/cli.ts` HELP) |
| [packages.md](./packages.md) | Catalog in v1 vs not-in-v1, hardness, refuse errors |
| [repo.md](./repo.md) | Current TS layout, MIT, GSXRcoder159/slim, CI matrix, slim.json |
| [release-identity.md](./release-identity.md) | Approved GitHub/Action/npm identity (`@gsxrcoder159/slim`) |
| [evidence.lodash.sample.md](./evidence.lodash.sample.md) | Copy of the golden fixture evidence report |
| [measurements.json](./measurements.json) | Versioned Node parse/size receipts (`measured` / `estimated` / `unavailable`) |
| [measurements.schema.json](./measurements.schema.json) | Schema for `measurements.json` |
| [slim.schema.json](./slim.schema.json) | Config schema (seven fields) |
| [scan.schema.json](./scan.schema.json) | `slim scan --json` report schema |
| [envelope.schema.json](./envelope.schema.json) | Envelope JSON (`inspect --json` / `.slim/<pkg>/envelope.json`) |
| [inspect.schema.json](./inspect.schema.json) | `slim inspect --json` wrapper |
| [check.schema.json](./check.schema.json) | `slim check --json` report |
| [doctor.schema.json](./doctor.schema.json) | `slim doctor --json` report |
| [upstream.schema.json](./upstream.schema.json) | `slim upstream --json` report |
| [error.schema.json](./error.schema.json) | `--json` usage/SlimExit document when a command has no payload |
| [transcripts/friday-lodash.txt](./transcripts/friday-lodash.txt) | **Historical** CLI dump — not the shipped surface |
| [samples/lodash.slice.js](./samples/lodash.slice.js) | **Historical** JS sketch; Friday slice is TypeScript in `fixtures/lodash-get-debounce/` |
| [examples/](./examples/) | User-repo GitHub workflows |

Core loop in v1: **envelope → generate → fuzz → PR → standing tests → watch**. No SaaS. No billing.
