#!/bin/bash
# 内部令牌分组改到可用组（newapi 的「无权访问 X 分组」= 该组不在 UserUsableGroups 且不等于用户自身分组）
M() { docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B'; }

echo "=== users（看用户自身分组） ==="
echo "SELECT id, username, HEX(\`group\`), status FROM users;" | M 2>/dev/null

echo "=== token 19 改到 特惠 组 ==="
echo "UPDATE tokens SET \`group\`=CONVERT(0xE789B9E683A0 USING utf8mb4) WHERE id=19;" | M 2>/dev/null
echo "SELECT id, \`key\`, LENGTH(\`key\`), HEX(\`group\`) FROM tokens WHERE id=19;" | M 2>/dev/null

cat > /tmp/t19c.json <<'EOF'
{"model":"typesafe/jev","messages":[{"role":"user","content":""}],"state":"女朋友突然发来一句：我没事，你忙你的吧。她平时这个点都会发可爱表情包，今天只发了句号。","questions":{"is_angry":{"type":"noul","instructions":"她是不是生气了？"},"action":{"type":"choice","instructions":"现在最应该做什么？","criteria":{"call":"立刻打电话，语气要温柔","red_packet":"先发个红包，金额带520","milk_tea":"点她最爱的奶茶送到楼下","apologize":"直接认错，虽然还不知道错哪了"}},"apology_score":{"type":"score","instructions":"这句道歉的诚意打几分？","criteria":["敷衍","一般","有诚意","非常真诚","可以直接原谅"]}}}
EOF

echo "=== 内部令牌冒烟（应 200） ==="
curl -sS -m 90 -o /tmp/t19c.out -w 'HTTP %{http_code}\n' -X POST https://ai.lu-k.cn/v1/chat/completions \
  -H "Authorization: Bearer ${CC_SITE_TOKEN}" \
  -H 'Content-Type: application/json' -d @/tmp/t19c.json || true
python3 -c "
import json,sys
try:
    d=json.load(open('/tmp/t19c.out'))
    print(d['choices'][0]['message']['content'])
    print('usage:', d['usage']['prompt_tokens'], d['usage']['completion_tokens'])
except Exception as e:
    print(open('/tmp/t19c.out').read()[:400])
"

echo "=== 代理容器状态 ==="
cd /opt/commandcode-proxy && docker compose ps
