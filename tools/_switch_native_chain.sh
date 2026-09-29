#!/bin/bash
# 渠道 11 → 自定义渠道(type 8) 直连代理原生端点 + 透传请求体；并把「内部」组加进渠道
M() { docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B'; }

BK=/root/cc-native-db-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BK"
echo 'SELECT * FROM channels WHERE id=11\G' | M > "$BK/channel11.txt" 2>/dev/null
echo "SELECT HEX(\`group\`), model, channel_id, enabled FROM abilities WHERE model LIKE '%jev%';" | M > "$BK/abilities.txt" 2>/dev/null
echo "SELECT \`key\`, value FROM options WHERE \`key\` IN ('GroupRatio','UserUsableGroups');" | M > "$BK/groups.txt" 2>/dev/null
echo "backup -> $BK"

echo "SELECT '--- before ---';" | M
cat "$BK/channel11.txt"

echo "SELECT '--- update ---';" | M
echo "UPDATE channels SET type=8, base_url='http://commandcode-proxy-proxy-1:3050/provider/v1/systemone', \`group\`=CONVERT(0xE58685E983A82CE69E81E4BD8E2CE789B9E683A02CE7A8B3E5AE9A USING utf8mb4), setting='{\"force_format\":false,\"thinking_to_content\":false,\"proxy\":\"\",\"pass_through_body_enabled\":true,\"responses_websocket_enabled\":false,\"system_prompt\":\"\",\"system_prompt_override\":false}' WHERE id=11;" | M
echo "SELECT id, type, base_url, models, HEX(\`group\`), status, setting FROM channels WHERE id=11;" | M

cat > /tmp/t1.json <<'EOF'
{"model":"typesafe/jev","state":"测试1：我的付款已经三天失败，也没有人回复","questions":{"is_urgent":{"type":"noul","instructions":"这条消息是否需要紧急处理？"},"department":{"type":"choice","instructions":"哪个团队应该处理这张工单？","criteria":{"billing":"付款、发票或退款","technical":"缺陷、故障或集成问题","sales":"定价、升级或新账户"}}}}
EOF
cat > /tmp/t2.json <<'EOF'
{"model":"typesafe/jev","messages":[{"role":"user","content":""}],"state":"测试2：我的付款已经三天失败，也没有人回复","questions":{"is_urgent":{"type":"noul","instructions":"这条消息是否需要紧急处理？"},"department":{"type":"choice","instructions":"哪个团队应该处理这张工单？","criteria":{"billing":"付款、发票或退款","technical":"缺陷、故障或集成问题","sales":"定价、升级或新账户"}}}}
EOF

TOK=${CC_SITE_TOKEN}
echo "等待渠道缓存刷新（同步周期 60s）…"
sleep 70

echo "=== 测试1：纯原生 body（无 messages） ==="
curl -sS -m 90 -o /tmp/t1.out -w 'HTTP %{http_code}\n' -X POST https://ai.lu-k.cn/v1/chat/completions \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d @/tmp/t1.json || true
head -c 900 /tmp/t1.out; echo

echo "=== 测试2：原生 + 一个空 messages 占位 ==="
curl -sS -m 90 -o /tmp/t2.out -w 'HTTP %{http_code}\n' -X POST https://ai.lu-k.cn/v1/chat/completions \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d @/tmp/t2.json || true
head -c 1100 /tmp/t2.out; echo

echo "=== abilities ==="
echo "SELECT HEX(\`group\`), model, channel_id, enabled FROM abilities WHERE model LIKE '%jev%';" | M 2>/dev/null

echo "=== 计费日志（最近 3 条 jev） ==="
echo "SELECT id, model_name, prompt_tokens, completion_tokens, quota, use_time, HEX(token_name) FROM logs WHERE model_name LIKE '%jev%' ORDER BY id DESC LIMIT 3;" | M 2>/dev/null
