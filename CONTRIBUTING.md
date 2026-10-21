# Contributing

Thanks for helping out. Bug reports, false-positive patterns and pull requests are all welcome.

## Setup

Node 24 is required.

```sh
npm ci
npm run all   # format check, lint, typecheck, tests, build, smoke test
```

## Layout

| Path                                     | What                                              |
| ---------------------------------------- | ------------------------------------------------- |
| `src/main.ts`                            | Orchestration: event parsing, decisions, outputs  |
| `src/pangram.ts`                         | Pangram client: submit, poll, error mapping       |
| `src/clean.ts`                           | Body cleaning, word count, hashing                |
| `src/skip.ts`                            | PR shape, bot/draft/author/label rules            |
| `src/heuristics.ts`, `src/disclosure.ts` | Local signals                                     |
| `src/messages.ts`, `src/template.ts`     | Comment templates and `{{placeholder}}` rendering |
| `src/report.ts`, `src/marker.ts`         | Sticky comment, signed cache marker, job summary  |
| `src/github.ts`, `src/repo.ts`           | GitHub REST calls                                 |
| `__tests__/`                             | Vitest tests, fixtures, and golden comment files  |
| `scripts/smoke.mjs`                      | Runs `dist/` end to end against mock APIs         |
| `scripts/backfill.ts`                    | Offline calibration over a repo's recent PRs      |

Most logic is pure and tested without the network. Golden files in `__tests__/golden/` pin the exact comment markdown; if you change a message on purpose, delete the affected file and re-run `npm test` to regenerate it, then review the diff.

## Pull requests

- Run `npm run build` and commit `dist/`. CI fails if it's stale.
- Keep `templates/*.md` identical to the defaults in `src/messages.ts` (a test checks this).
- New inputs go in `action.yml`, `src/config.ts` and the README tables (a test checks that `action.yml` and `config.ts` agree).

## Releasing

Run the **Release** workflow with a version like `1.2.3`. It runs the full check, tags `v1.2.3`, moves `v1`, and creates a GitHub release.
