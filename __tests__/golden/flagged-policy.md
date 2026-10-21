### AI description check: flagged

Pangram estimates **78% of this description is AI-generated** (threshold 50%, model pangram-4).

What stood out:
- 2 of 3 segments classified AI-generated (high confidence)
- Most AI-like passage: `This PR introduces a comprehensive update to the consumer configuration.`
- 169-word description for a 3-line change
- Heading/bullet structure heavier than the diff warrants (5 headings, 7 bullets for a 3-line change)
- Most bullets name files or identifiers, restating the diff (5 of 7)
- Stock phrasing ("this PR introduces/adds", "comprehensive", "robust", "seamless", …)
- Typography tells (2 em dashes, 5 emoji-led headings/bullets)

This is a best-effort check, and detectors can be wrong. To get this through, either:
1. **Rewrite the description** in your own words: what changed, why, and how it was tested. Short is fine. The check re-runs when you save the edit.
2. **Add the `skip-ai-check` label** if you believe this is a false positive or the description is fine as is. No justification needed.

Why we check: https://example.com/ai-policy

Questions or false positives: https://github.com/mwarkentin/lazy-dog#false-positives

We check PR descriptions because reviewers rely on them to understand intent.
See our [AI use policy](https://example.com/ai-policy). Questions: #ops in Slack.