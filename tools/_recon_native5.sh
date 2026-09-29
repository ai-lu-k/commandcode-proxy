#!/bin/bash
M() { docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B'; }

echo "===TOKEN19==="
echo "SELECT id, \`key\`, LENGTH(\`key\`), HEX(\`group\`), status, expired_time, model_limits_enabled, HEX(model_limits) FROM tokens WHERE id=19;" | M 2>/dev/null

echo "===TOKEN_OTHERS_PREFIX==="
echo "SELECT id, LEFT(\`key\`,10), LENGTH(\`key\`), HEX(\`group\`), status FROM tokens WHERE id IN (1,4);" | M 2>/dev/null

echo "===ABILITIES_jev==="
echo "SELECT HEX(\`group\`), model, channel_id, enabled FROM abilities WHERE model LIKE '%jev%';" | M 2>/dev/null

echo "===ABILITY_COLS==="
echo "SHOW COLUMNS FROM abilities;" | M 2>/dev/null

echo "===CH11_NOW==="
echo "SELECT id, type, base_url, models, HEX(\`group\`), status, setting FROM channels WHERE id=11;" | M 2>/dev/null

echo "===JEVA_LOG_LAST==="
echo "SELECT id, user_id, token_name, model_name, prompt_tokens, completion_tokens, quota, FROM_UNIXTIME(created_at) FROM logs WHERE model_name LIKE '%jev%' ORDER BY id DESC LIMIT 5;" | M 2>/dev/null
