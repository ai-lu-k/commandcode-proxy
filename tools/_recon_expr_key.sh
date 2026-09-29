#!/bin/bash
cd /tmp/new-api.inspect || exit 1

echo "===RELAY_TASK_240_280==="
sed -n '240,280p' relay/relay_task.go

echo "===TIERED_BILLING_1_70==="
sed -n '1,70p' setting/billing_setting/tiered_billing.go

echo "===KEY_FUNCS==="
grep -n -A18 'func PluginBillingExprKey\|func SplitPluginBillingExprKey\|func GetPluginBillingExpr\b\|func GetPluginBillingExpr(' setting/billing_setting/tiered_billing.go | head -80
