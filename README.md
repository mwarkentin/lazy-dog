# lazy-dog

Flags lazy, AI-generated PR descriptions using [Pangram](https://www.pangram.com) plus cheap local heuristics.

A GitHub Action that sends a pull request's description to Pangram's AI-detection API, reports the score in a sticky PR comment and the job summary, and can fail the check above a threshold. It's a best-effort nudge for trusted teams, not an enforcement gate: detectors can be wrong, and anyone who can label a PR can wave it through.

> [!NOTE]
> This project is not affiliated with or endorsed by Pangram Labs. You need your own Pangram API key ([Developers plan](https://www.pangram.com/knowledge-hub/what-is-pangrams-developers-plan)); API access isn't included in Pangram's Individual, Professional or Teams plans.

## Quickstart

1. Add your Pangram API key as a repository or organization secret named `PANGRAM_API_KEY`.
2. Add `.github/workflows/ai-description-check.yml`:

```yaml
name: AI description check

on:
  pull_request_target:
    types: [opened, edited, reopened, synchronize, ready_for_review, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: ai-description-check-${{ github.event.pull_request.number }}

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      # No actions/checkout! See "Security" below.
      - uses: mwarkentin/lazy-dog@<full-commit-sha> # v1.0.0
        with:
          pangram-api-key: ${{ secrets.PANGRAM_API_KEY }}
          mode: warn
```

More in [`examples/`](examples): a [warn-only rollout](examples/warn.yml) and [fail mode with a policy link](examples/fail.yml).

Start in `mode: warn` for a few weeks, look at what gets flagged, then decide on `mode: fail`, the threshold, and whether to make it a required check.

## Security

> [!IMPORTANT]
> **`pull_request_target` is safe here only because this action never checks out or executes PR code.** Do not add `actions/checkout` (or any step that runs code from the PR) to the job. The action warns in the log if it finds the PR head commit in the workspace.

- **Why `pull_request_target`:** with plain `pull_request`, PRs from forks get no secrets, so they can't be scored. `pull_request_target` runs the workflow from the base branch with secrets available. If you use `pull_request` instead, fork PRs skip cleanly (`skip-reason: no-pangram-key`) rather than fail.
- **Untrusted input:** the PR body is attacker-controlled. The action reads it from the event payload and the REST API, never through `${{ github.event.pull_request.body }}` in a `run:` step, and never renders it as markdown: at most one short flagged passage is quoted, inside a code span.
- **Templates come from the base branch:** `failure-message-file` and the PR template are read from the PR's base branch via the contents API, never from the PR head.
- **Signed cache:** the sticky comment carries a hidden marker with the last score. It is signed with an HMAC keyed by your Pangram API key, so a forged comment can't plant a fake low score. Rotating the key just causes one rescan.
- **Permissions:** `contents: read` (PR template, custom message file) and `pull-requests: write` (the comment). Nothing else.
- **Data egress:** PR descriptions are sent to Pangram, a third party. Check that this is acceptable for private repositories. Results are never made publicly linkable (`public_dashboard_link` is always `false`).
- **Pinning:** pin the action to a full commit SHA. Releases are tagged `vX.Y.Z` with a moving `vX` major tag.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## How it decides

1. Re-fetch the PR, so labels and edits made since the event (or on a re-run) are seen.
2. Skip closed and draft PRs, bots (`skip-bots`), and `skip-authors`.
3. Clean the body: drop HTML comments, fenced code, lines from the repo's PR template (`strip-template`), `strip-patterns` matches, AI disclosure footers, images, URLs and ticket IDs; keep link text; collapse whitespace.
4. Skip if fewer than `min-words` remain (Pangram's minimum reliable input is 50 words); truncate at `max-words`.
5. Run the [heuristics](#heuristics) and detect [disclosure](#disclosure).
6. Hash the cleaned text (SHA-256). If the sticky comment holds a verified score for the same hash and model, reuse it: no API call.
7. Otherwise call Pangram (`POST /task`, then poll `GET /task/{id}` with about 1s backoff, within `timeout-seconds`).
8. Compare the `metric` with the `threshold`: above it is `flag`, otherwise `pass`.
9. Write the job summary, upsert the sticky comment, set outputs, and fail the check only if `mode: fail` and the verdict is `flag` and the PR isn't bypassed.

Some consequences:

- **Edits re-run the check.** Title-only edits, pushes and unrelated label changes reuse the cached score. They aren't skipped outright, because a skipped run would post a passing check over a failing one.
- **Include `synchronize` if the check is required.** Required checks are per head commit, so every push needs a result. The body hasn't changed, so it costs nothing.
- **A pass after a flag edits the same comment** to "passed" rather than leaving the old warning up. Skips (say, the PR went back to draft) update an existing comment too.

## Inputs

| Input                               | Default                                 | Description                                                                                                                                   |
| ----------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pangram-api-key`                   |                                         | Pangram API key, from a secret. When empty the check skips cleanly.                                                                           |
| `github-token`                      | `${{ github.token }}`                   | Reads the PR, template and comments; writes the comment.                                                                                      |
| `model`                             | `pangram-4`                             | Pangram model selector, always sent explicitly so scores don't drift when Pangram changes its default.                                        |
| `metric`                            | `fraction_ai`                           | `fraction_ai`, `fraction_ai_assisted`, or `max` (the larger of the two).                                                                      |
| `threshold`                         | `0.5`                                   | Flag when the metric is above this (0–1, or a percentage like `50%`).                                                                         |
| `mode`                              | `warn`                                  | `warn` (always pass, report only) or `fail`.                                                                                                  |
| `min-words`                         | `50`                                    | Skip below this many words after cleaning.                                                                                                    |
| `max-words`                         | `2000`                                  | Truncate above this to cap cost.                                                                                                              |
| `strip-template`                    | `true`                                  | Remove lines that match the repo's PR template (any of the locations GitHub supports, including a `PULL_REQUEST_TEMPLATE/` directory).        |
| `strip-patterns`                    |                                         | Extra regexes to delete before scoring, one per line. Plain lines use flags `gm`; `/source/flags` is also accepted.                           |
| `skip-bots`                         | `true`                                  | Skip authors whose user type is `Bot` or whose login ends in `[bot]`.                                                                         |
| `skip-authors`                      |                                         | Comma- or newline-separated logins to skip, e.g. machine users.                                                                               |
| `skip-label`                        | `skip-ai-check`                         | [Bypass label](#bypass-label).                                                                                                                |
| `bypass-label-skip-scan`            | `false`                                 | With the bypass label on and no cached score, don't call Pangram at all.                                                                      |
| `skip-if-disclosed`                 | `false`                                 | Skip descriptions that [disclose AI use](#disclosure).                                                                                        |
| `comment`                           | `true`                                  | Sticky comment: `true` (every scored PR), `on-flag` (only once flagged, then kept current), or `false`.                                       |
| `fail-on-error`                     | `false`                                 | Whether Pangram or infrastructure errors (out of credits, rate limits, timeouts, a bad key) fail the check.                                   |
| `timeout-seconds`                   | `60`                                    | Total budget for submitting and polling.                                                                                                      |
| `heuristics`                        | `signal`                                | `off`, `signal`, or `gate`. See [Heuristics](#heuristics).                                                                                    |
| `heuristic-threshold`               | `0.25`                                  | Heuristic score at which `gate` mode calls Pangram.                                                                                           |
| `scan-on`                           |                                         | PR event types that may call Pangram, e.g. `opened,ready_for_review` for one scan per PR. Other events reuse the last score. Empty means all. |
| `policy-url`                        |                                         | Your policy page, shown as "Why we check" in the default failure message.                                                                     |
| `help-url`                          | this README                             | Where to send questions and false-positive reports.                                                                                           |
| `failure-message`                   | built-in                                | Markdown template for the flagged comment.                                                                                                    |
| `failure-message-file`              |                                         | Path to a failure template in the repo, read from the base branch.                                                                            |
| `message-header` / `message-footer` |                                         | Markdown above and below every comment.                                                                                                       |
| `pass-message`                      | built-in                                | Template for the passed comment.                                                                                                              |
| `bypass-message`                    | built-in                                | Template for the bypassed comment.                                                                                                            |
| `pangram-api-url`                   | `https://text.external-api.pangram.com` | Override for testing only.                                                                                                                    |

## Outputs

| Output                                                  | Description                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skipped` / `skip-reason`                               | `true` when there's no score, with why: `closed`, `draft`, `bot`, `skip-author`, `too-short`, `disclosed`, `no-pangram-key`, `bypass-label`, `not-scanned-on-event`, `below-heuristic-threshold`, `api-error`, `not-a-pull-request`. |
| `fraction-ai`, `fraction-ai-assisted`, `fraction-human` | Pangram's fractions, 0–1.                                                                                                                                                                                                            |
| `prediction`                                            | `AI`, `Human` or `Mixed`.                                                                                                                                                                                                            |
| `word-count`                                            | Words sent to Pangram, after cleaning and truncation. Log it to check spend.                                                                                                                                                         |
| `model-version`                                         | Pangram's model version, e.g. `4.0`, for reproducibility.                                                                                                                                                                            |
| `verdict`                                               | `pass` or `flag`; empty when skipped. A bypassed PR keeps its verdict, so check `bypassed` too.                                                                                                                                      |
| `bypassed` / `bypassed-by`                              | Whether the bypass label is on, and who added it.                                                                                                                                                                                    |
| `heuristic-score`                                       | Combined heuristic score, 0–1.                                                                                                                                                                                                       |
| `disclosed`                                             | Whether the description discloses AI use.                                                                                                                                                                                            |
| `cached`                                                | `true` when the score came from the cache rather than a new Pangram call.                                                                                                                                                            |
| `comment-url`                                           | The sticky comment, if any.                                                                                                                                                                                                          |

## Bypass label

Anyone who can label the PR (triage or write access) can wave it through with the bypass label (`skip-ai-check` by default):

- Adding the label re-runs the check, which passes. The score is still reported from the cache, without a new API call, and the comment says who bypassed it.
- Removing the label re-evaluates.
- `bypassed` and `bypassed-by` outputs let you track bypass rates.
- With `bypass-label-skip-scan: true`, a PR labelled before it was ever scored isn't sent to Pangram at all.

## Messages

Every author-facing message is a template you control. The defaults live in [`templates/`](templates) for copying:

- [`failure.md`](templates/failure.md): flagged
- [`pass.md`](templates/pass.md): passed, including after an earlier flag
- [`bypass.md`](templates/bypass.md): bypassed

Use `message-header` / `message-footer` for a light touch, or replace a template with `failure-message`, `failure-message-file`, `pass-message` or `bypass-message`. Templates use `{{placeholder}}` substitution, with no expression language:

| Placeholder                          | Example                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `{{score}}`                          | `78%`                                                                                         |
| `{{metric}}` / `{{metric_label}}`    | `fraction_ai` / `AI-generated`                                                                |
| `{{threshold}}`                      | `50%`                                                                                         |
| `{{model}}` / `{{model_version}}`    | `pangram-4` / `4.0`                                                                           |
| `{{prediction}}`                     | `AI`                                                                                          |
| `{{signals}}`                        | Bulleted list of what fired (Pangram segments, one quoted passage, heuristics)                |
| `{{bypass_label}}`                   | `skip-ai-check`                                                                               |
| `{{bypassed_by}}`                    | `@login` of whoever added the label                                                           |
| `{{author}}`                         | `@login` of the PR author                                                                     |
| `{{policy_url}}` / `{{policy_link}}` | The URL / `Why we check: <url>`, or empty                                                     |
| `{{help_url}}`                       | The `help-url` input                                                                          |
| `{{word_count}}`                     | `240`                                                                                         |
| `{{diff_lines}}`                     | `3`                                                                                           |
| `{{heuristic_score}}`                | `0.29`                                                                                        |
| `{{score_summary}}`                  | `Pangram estimates 78% of this description is AI-generated (threshold 50%, model pangram-4).` |

Templates are trusted, since they come from your workflow or base branch. Values derived from the PR are escaped. If a custom failure template omits `{{bypass_label}}`, the job log warns you that authors won't see a way through.

For example, to link your policy:

```yaml
with:
  policy-url: https://example.com/ai-use-policy
  message-footer: |
    We check PR descriptions because reviewers rely on them to understand intent.
    See our [AI use policy]({{policy_url}}). Questions: #ops in Slack.
```

The comment always says "Pangram estimates X% …", never "this PR was written by AI".

## Heuristics

Free, explainable signals computed before Pangram. They show up under "What stood out" and in the job summary. They're hints, not verdicts: in an infra repo, a one-line config change with a long incident write-up is good practice.

| Signal                      | Rule                                                                                                                         | Weight |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| Description vs diff         | > 150 words and > 15 words per changed line                                                                                  | Medium |
| Structure for a tiny change | ≥ 3 headings or ≥ 10 bullets when the diff is < 20 lines (counted after template stripping)                                  | Medium |
| Restating the diff          | ≥ 3 bullets and most name files or code identifiers                                                                          | Low    |
| Stock phrasing              | ≥ 2 stock phrases, at least 1 per 100 words ("this PR introduces", "comprehensive", "robust", "seamless", "ensures that", …) | Low    |
| Typography                  | ≥ 2 em dashes (at least 1 per 100 words), or ≥ 2 emoji-led headings or bullets                                               | Low    |

`heuristic-score` is the fired weight over the total (medium counts double). Diff stats come from the PR itself, so no extra API calls.

- `heuristics: off`: Pangram only.
- `heuristics: signal` (default): show the breakdown; only Pangram can fail the check.
- `heuristics: gate`: call Pangram only when `heuristic-score` ≥ `heuristic-threshold`. This is the cheapest option, but it misses AI text that happens to be short and well-proportioned.

### Disclosure

A "Generated with Claude Code"-style footer, an AI `Co-Authored-By` trailer, or a statement like "drafted with the help of AI" sets `disclosed: true`. Disclosure never counts against a PR, and the disclosure line itself is removed before scoring. If your policy is "AI is fine, undisclosed AI isn't", set `skip-if-disclosed: true`.

## Cost

Pangram's Developers plan bills $0.05 per 100 words. Built-in levers, in order of impact:

1. **Hash cache:** edits that don't change the cleaned text cost nothing.
2. **Skips:** bots, drafts and bodies under `min-words`.
3. **`max-words`:** caps the occasional very long description.
4. **`scan-on: opened,ready_for_review`:** one scan per PR.

Buy credits with auto-refill and set a spend alert on the Pangram side. `word-count` is logged and output on every run, so actual spend can be compared with your estimate.

## Calibrating

Before turning anything on, score your recent PRs offline with the same cleaning, skip rules and heuristics:

```sh
npm ci
GITHUB_TOKEN=... npm run backfill -- owner/repo --limit 300 > prs.csv                         # heuristics only
GITHUB_TOKEN=... PANGRAM_API_KEY=... npm run backfill -- owner/repo --limit 300 --pangram --yes > prs.csv
```

The script prints the eligible count and estimated cost first. Without `--pangram`, nothing leaves GitHub.

## False positives

AI detectors make mistakes, and short or formulaic text (checklists, generated changelogs, non-native English) is harder to score. If this check flagged your description and you wrote it yourself:

1. Add the bypass label (`skip-ai-check` unless your repo configured another). No justification is needed.
2. Or rewrite the description in your own words: what changed, why, and how it was tested. The check re-runs when you save.

Maintainers: if a pattern keeps tripping the check, raise the threshold, add `strip-patterns` for boilerplate, or report it in this repo's issues.

## Development

```sh
npm ci
npm run all   # format check, lint, typecheck, tests, build, smoke test of dist/
```

`dist/` is committed and CI fails if it's stale, so run `npm run build` before committing source changes. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
