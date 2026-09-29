#!/bin/bash
cd /tmp/new-api.inspect || exit 1

echo "===INGRESS_RULES==="
cat /opt/llm-evidence/config/rules.json 2>/dev/null | head -120

echo "===CTRL_FILES==="
ls controller/ | grep -iE 'plugin|task'

echo "===MODEL_FILES==="
ls model/ | grep -iE 'plugin|task'

echo "===TASKPLUGINS_USAGE==="
grep -rn 'task_plugins' --include='*.go' . | head -20

echo "===LOAD_FUNCS==="
grep -rnE 'func .*(LoadTaskPlugins|InitTaskPlugins|ReloadTaskPlugins|ActivateTaskPlugin)' --include='*.go' . | head -20

echo "===JSPLUGIN_DIR==="
ls pkg/jsplugin/ 2>/dev/null | head -30

echo "===PLUGIN_BILLING==="
grep -rn 'plugin_billing_expr' --include='*.go' . | head -10
