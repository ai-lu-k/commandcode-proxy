#!/bin/bash
# 用站点上已验证可用的 token（走 newapi 计费）冒烟：纯原生 body vs 带空 messages 占位
M() { docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B'; }

TOK=$(echo "SELECT \`key\` FROM tokens WHERE id=4;" | M 2>/dev/null | tr -d '[:space:]')
echo "token prefix: ${TOK:0:8}…  len=${#TOK}"

cat > /tmp/n1.json <<'EOF'
{"model":"typesafe/jev","state":"冒烟1：我的付款已经三天失败，也没有人回复","questions":{"is_urgent":{"type":"noul","instructions":"这条消息是否需要紧急处理？"},"department":{"type":"choice","instructions":"哪个团队应该处理这张工单？","criteria":{"billing":"付款、发票或退款","technical":"缺陷、故障或集成问题","sales":"定价、升级或新账户"}}}}
EOF
cat > /tmp/n2.json <<'EOF'
{"model":"typesafe/jev","messages":[{"role":"user","content":""}],"state":"冒烟2：我的付款已经三天失败，也没有人回复","questions":{"is_urgent":{"type":"noul","instructions":"这条消息是否需要紧急处理？"},"department":{"type":"choice","instructions":"哪个团队应该处理这张工单？","criteria":{"billing":"付款、发票或退款","technical":"缺陷、故障或集成问题","sales":"定价、升级或新账户"}}}}
EOF

echo "=== 冒烟1：纯原生 body（顶层 state/questions，无 messages） ==="
curl -sS -m 90 -o /tmp/n1.out -w 'HTTP %{http_code}\n' -X POST https://ai.lu-k.cn/v1/chat/completions \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d @/tmp/n1.json || true
head -c 900 /tmp/n1.out; echo

echo "=== 冒烟2：原生 + 空 messages 占位 ==="
curl -sS -m 90 -o /tmp/n2.out -w 'HTTP %{http_code}\n' -X POST https://ai.lu-k.cn/v1/chat/completions \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d @/tmp/n2.json || true
head -c 1100 /tmp/n2.out; echo

echo "=== 刚才这次有没有计费 ==="
echo "SELECT id, token_name, model_name, prompt_tokens, completion_tokens, quota, FROM_UNIXTIME(created_at) FROM logs WHERE model_name LIKE '%jev%' ORDER BY id DESC LIMIT 3;" | M 2>/dev/null

echo "=== 代理侧最近日志（原生端点 / 决策请求） ==="
docker logs --tail 12 commandcode-proxy-proxy-1 2>&1 | tail -12
