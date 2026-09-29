#!/bin/bash
cd /tmp/new-api.inspect || exit 1

echo "===PASS_SITES==="
grep -rn 'PassThroughBodyEnabled' --include='*.go' relay/ service/ controller/ 2>/dev/null

echo "===VALID_CALLERS==="
grep -rn 'GetAndValidateTextRequest' --include='*.go' . | grep -v _test | head -10

echo "===VALID_CALLSITE_CTX==="
for f in $(grep -rln 'GetAndValidateTextRequest' --include='*.go' . | grep -v _test | head -3); do
  echo "--- $f ---"
  grep -n -A6 -B12 'GetAndValidateTextRequest' "$f" | head -60
done

echo "===CHANNEL_COLS==="
docker exec new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B -e "SHOW COLUMNS FROM channels;"' 2>/dev/null | awk '{print $1}' | tr '\n' ' '
echo

echo "===CH_1_2_11==="
docker exec new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B -e "SELECT id, type, base_url, models, HEX(\`group\`), status, HEX(setting), HEX(other), HEX(param_override) FROM channels WHERE id IN (1,2,11);"' 2>/dev/null
