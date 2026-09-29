#!/bin/bash
M() { docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B'; }

echo "===CH11==="
echo "SELECT id, type, base_url, models, HEX(\`group\`), status FROM channels WHERE id=11;" | M
echo "===ABILITIES_jev==="
echo "SELECT HEX(\`group\`), model, channel_id, enabled FROM abilities WHERE model LIKE '%jev%';" | M
echo "===TOKENS==="
echo "SELECT id, HEX(name), HEX(\`group\`), status, unlimited_quota FROM tokens ORDER BY id;" | M
echo "===GROUP_OPTIONS==="
echo "SELECT \`key\`, LEFT(value,200) FROM options WHERE \`key\` IN ('GroupRatio','UserUsableGroups');" | M
