# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/mwarkentin/lazy-dog/security/advisories/new) rather than in a public issue. You should get a response within a few days.

Relevant reports include anything that lets a pull request author:

- run code or read secrets in a workflow using this action,
- inject markdown, HTML or mentions into the sticky comment or job summary,
- forge or replay the cached score in the sticky comment, or
- make the check pass in `mode: fail` without the bypass label.

## Supported versions

Only the latest release of the current major version gets security fixes.

## Using this action safely

- Never add `actions/checkout` or any step that runs PR code to a `pull_request_target` job that uses this action.
- Pin the action to a full commit SHA.
- Grant only `contents: read` and `pull-requests: write`.
