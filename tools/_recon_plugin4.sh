#!/bin/bash
cd /tmp/new-api.inspect || exit 1

echo "===EMBEDDED_PLUGINS_TREE==="
find plugins -maxdepth 3 -type d 2>/dev/null | head -20
find plugins -maxdepth 3 -type f -name '*.js' 2>/dev/null | head -20
echo "--- embed.go ---"
sed -n '1,80p' plugins/embed.go 2>/dev/null

echo "===MODEL_TASK_PLUGIN_STRUCT==="
sed -n '1,90p' model/task_plugin.go

echo "===UPLOAD_FUNC==="
grep -n 'func ' model/task_plugin.go | head -30

echo "===CONTROLLER_UPLOAD_SIG==="
grep -n 'func UploadTaskPlugin' -A40 controller/task_plugin.go | head -60
