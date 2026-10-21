## Summary

<!-- What does this PR change, and why? -->

Bumps the snuba consumer memory limit from 2Gi to 3Gi in us-east. We got paged twice last night (INC-482) because
the consumers kept getting OOMKilled after the new partitioning went out, and lag went up to about 40 minutes
before things settled. I looked at the memory graphs for the last week and peak usage is sitting right around
2.1Gi now, so 3Gi gives us headroom until we figure out why the new partitioning uses more memory.

See https://sentry.io/organizations/sentry/issues/12345/ and #9876 for context.

## How was this tested?

<!-- Describe the tests you ran. -->

Applied it to the canary pod by hand yesterday afternoon and it has been fine overnight. Will watch the dashboard after
the deploy.

## Checklist

- [x] I added or updated tests
- [ ] I updated the runbook if behaviour changed
- [x] This change is safe to roll back
