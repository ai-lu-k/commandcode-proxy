#!/bin/bash
cd /tmp/new-api.inspect || exit 1
M() { docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B'; }

echo "===OPTIONS(token/access)==="
echo "SELECT \`key\`, LEFT(value,60) FROM options WHERE \`key\` LIKE '%ccess%' OR \`key\` LIKE '%oken%' OR \`key\` LIKE '%plugin%';" | M 2>/dev/null

echo "===PLUGIN_ADMIN_API==="
grep -rn 'task_plugin\|taskPlugin\|TaskPlugin' router/*.go controller/*.go 2>/dev/null | head -25

echo "===PLUGIN_ROUTES==="
grep -rn 'plugins\|plugin' router/*.go 2>/dev/null | head -25

echo "===TASKPLUGINS_TABLE_CURRENT==="
echo "SELECT COUNT(*) FROM task_plugins;" | M 2>/dev/null

echo "===INGRESS_CONTAINER==="
docker exec llm-evidence-audit-1 sh -c 'ls / ; echo ---; ls /app 2>/dev/null | head; echo ---; env | grep -iE "route|path|upstream|target|port" | head -20' 2>&1 | head -40

echo "===INGRESS_CONF_FILES==="
docker exec llm-evidence-audit-1 sh -c 'find / -maxdepth 3 -name "*.conf" -o -maxdepth 3 -name "*.yaml" -o -maxdepth 3 -name "*.yml" -o -maxdepth 3 -name "*.json" 2>/dev/null | grep -v proc | head -20' 2>&1 | head -25

echo "===INGRESS_CMD==="
docker inspect llm-evidence-audit-1 --format '{{.Config.Cmd}} | {{.Config.Entrypoint}} | {{.Path}}' 2>/dev/null
docker inspect llm-evidence-audit-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' 2>/dev/null | head -10
