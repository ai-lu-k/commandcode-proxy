#!/bin/bash
cd /tmp/new-api.inspect || exit 1
M() { docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B'; }

echo "===TABLES(plugin/任务相关)==="
echo "SHOW TABLES;" | M 2>/dev/null | grep -iE 'plugin|task|route' | tr '\n' ' '
echo
echo "===ALL_TABLES_COUNT==="
echo "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='new_api';" | M 2>/dev/null

echo "===PLUGIN_COLS==="
for t in plugins task_plugins; do echo "--- $t ---"; echo "SHOW COLUMNS FROM $t;" | M 2>/dev/null | awk '{print $1"("$2")"}' | tr '\n' ' '; echo; done

echo "===PLUGIN_ROWS==="
echo "SELECT id, \`key\`, kind, version, status, source FROM plugins;" | M 2>/dev/null
echo "SELECT id, \`key\`, kind, version, status, source FROM task_plugins;" | M 2>/dev/null

echo "===SOURCE_TYPESAFE==="
grep -rln 'typesafe' --include='*.go' --include='*.js' . 2>/dev/null | grep -v node_modules | head -10

echo "===CHANNEL_TYPES==="
grep -nE 'ChannelTypeTaskPlugin|ChannelType.*= (60|61|62)$' constant/channel.go | head -20

echo "===CONTAINER_APP==="
docker exec new-api sh -c 'cat /app/VERSION 2>/dev/null; ls /app | head -20; ls -R /app/plugins 2>/dev/null | head -30' 2>&1 | head -60

echo "===NGINX_VHOST_FILES==="
ls /www/server/panel/vhost/nginx/ 2>/dev/null | head -10
echo "--- ai.lu-k.cn 里的 location/proxy_pass ---"
grep -rn 'location\|proxy_pass' /www/server/panel/vhost/nginx/*.conf 2>/dev/null | head -40

echo "===CONTAINERS==="
docker ps --format '{{.Names}} | {{.Image}} | {{.Ports}}' | head -20
