#!/bin/bash
cd /tmp/new-api.inspect || exit 1

echo "===GREP_MSG==="
grep -rn 'usage expression' --include='*.go' . | head -10
grep -rn 'or meter' --include='*.go' . | head -10

echo "===PLUGIN_BILLING_EXPR_USAGE==="
grep -rn 'PluginBillingExpr\|plugin_billing_expr' --include='*.go' . | grep -v _test | head -20

echo "===METER==="
grep -rn 'Meter\b' --include='*.go' setting/ service/ relay/ | grep -v _test | head -20
