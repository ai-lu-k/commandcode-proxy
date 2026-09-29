#!/bin/bash
cd /tmp/new-api.inspect || exit 1

echo "===RUNTIME_SYNC_SITES==="
grep -rn 'GetTaskPluginSyncSnapshot' --include='*.go' . | head -10
grep -rnE 'go [a-zA-Z]*(Sync|Reload)[A-Za-z]*TaskPlugin|SyncTaskPluginRuntime|RefreshTaskPlugin' --include='*.go' . | head -20
grep -rn 'jsplugin.DefaultRegistry.Reload\|RegistryReload\|SetGenerationPreparer' --include='*.go' . | head -10

echo "===BILLING_OPTIONS==="
grep -nE 'Option = |billing_mode|BillingMode' setting/billing_setting/tiered_billing.go | head -25

echo "===UI_CHANNEL_SAMPLE(task_plugin_key)==="
grep -rn 'task_plugin_key' --include='*.tsx' --include='*.ts' web/src | head -10

echo "===CHANNEL_TASK_PLUGIN_VALIDATION_TEST==="
sed -n '1,80p' controller/channel_task_plugin_validation_test.go

echo "===TASKPLUGIN_ACTIVE_COLS==="
grep -n -A22 'type TaskPlugin struct' model/task_plugin.go | sed -n '20,50p'
