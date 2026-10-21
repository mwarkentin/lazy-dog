## 🚀 Summary

This PR introduces a comprehensive update to the consumer configuration — ensuring that memory limits are robust and seamlessly aligned with observed usage patterns.

## ✨ Key Changes

- Updated `snuba/consumer.yaml` to raise the memory limit from 2Gi to 3Gi
- Adjusted `values/us-east.yaml` to leverage the new resource profile
- Modified `charts/snuba/templates/deployment.yaml` for consistency
- Refactored `limits.tf` to streamline resource definitions

## 🧪 Testing

- Verified the configuration renders correctly with `helm template`
- Confirmed that the pods start successfully in the canary environment
- Monitored memory usage to ensure that the new limits are respected

## 📈 Impact

Overall, these changes facilitate more reliable consumer behaviour — reducing the likelihood of OOM-related incidents and improving operational resilience. Furthermore, the updated configuration enhances maintainability across environments, making future adjustments straightforward and predictable.

## 🔄 Rollback Plan

If any issues arise, the change can be safely reverted by restoring the previous memory limit in `snuba/consumer.yaml`. No data migrations or schema changes are involved, so rollback is low-risk and can be performed seamlessly through the standard deployment pipeline.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
