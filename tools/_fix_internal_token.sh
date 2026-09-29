#!/bin/bash
# 修令牌：newapi 库里存的是去掉 sk- 前缀的 key；补「内部」组的能力行；用内部令牌冒烟
M() { docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B'; }

echo "=== 修前 ==="
echo "SELECT id, \`key\`, LENGTH(\`key\`), HEX(\`group\`) FROM tokens WHERE id=19;" | M 2>/dev/null

echo "=== 去掉 sk- 前缀（库里其它令牌都是 48 位无前缀） ==="
echo "UPDATE tokens SET \`key\`='0tFsdY1VFlvwSu2lhbYDaFzFEYbpjD3FM8A5LGTTqNhpAvIt' WHERE id=19;" | M 2>/dev/null
echo "SELECT id, \`key\`, LENGTH(\`key\`), HEX(\`group\`) FROM tokens WHERE id=19;" | M 2>/dev/null

echo "=== 补「内部」组能力行 ==="
echo "SELECT HEX(\`group\`), model, channel_id, enabled FROM abilities WHERE model LIKE '%jev%';" | M 2>/dev/null
echo "INSERT IGNORE INTO abilities (\`group\`, model, channel_id, enabled, priority, weight) VALUES (CONVERT(0xE58685E983A8 USING utf8mb4),'typesafe/jev',11,1,0,0);" | M 2>/dev/null
echo "SELECT HEX(\`group\`), model, channel_id, enabled FROM abilities WHERE model LIKE '%jev%';" | M 2>/dev/null

TOK=${CC_SITE_TOKEN}
cat > /tmp/t19.json <<'EOF'
{"model":"typesafe/jev","messages":[{"role":"user","content":""}],"state":"内部令牌冒烟：我的付款已经三天失败，也没有人回复","questions":{"is_urgent":{"type":"noul","instructions":"这条消息是否需要紧急处理？"},"department":{"type":"choice","instructions":"哪个团队应该处理这张工单？","criteria":{"billing":"付款、发票或退款","technical":"缺陷、故障或集成问题","sales":"定价、升级或新账户"}}}}
EOF

echo "=== 内部令牌冒烟 ==="
curl -sS -m 90 -o /tmp/t19.out -w 'HTTP %{http_code}\n' -X POST https://ai.lu-k.cn/v1/chat/completions \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d @/tmp/t19.json || true
head -c 700 /tmp/t19.out; echo
