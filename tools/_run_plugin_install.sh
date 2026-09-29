#!/bin/bash
# 装插件 + 重启 new-api 载入插件路由 + 冒烟 /v1/systemone
python3 /tmp/_install_plugin_typesafe.py || exit 1

echo "=== 重启 new-api（插件路由在启动时构建）==="
docker restart new-api >/dev/null 2>&1
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3000/api/status 2>/dev/null)
  [ "$code" = "200" ] && { echo "new-api 就绪（${i}s，HTTP $code）"; break; }
  sleep 1
done
sleep 2

cat > /tmp/so.json <<'EOF'
{
  "model": "jev-latest",
  "state": "女朋友突然发来一句：“我没事，你忙你的吧。” 但她平时这个点都会发可爱的表情包，今天只发了句号。",
  "questions": {
    "is_angry": { "type": "noul", "instructions": "她是不是生气了？" },
    "action": {
      "type": "choice",
      "instructions": "现在最应该做什么？",
      "criteria": {
        "call": "立刻打电话，语气要温柔",
        "red_packet": "先发个红包，金额带520",
        "milk_tea": "点她最爱的奶茶送到楼下",
        "apologize": "直接认错，虽然还不知道错哪了"
      }
    },
    "apology_score": {
      "type": "score",
      "instructions": "这句道歉的诚意打几分？",
      "criteria": ["敷衍", "一般", "有诚意", "非常真诚", "可以直接原谅"]
    }
  }
}
EOF

echo "=== 用内部令牌打 /v1/systemone ==="
curl -sS -m 90 -o /tmp/so.out -w 'HTTP %{http_code}\n' -X POST https://ai.lu-k.cn/v1/systemone \
  -H "Authorization: Bearer ${CC_SITE_TOKEN}" \
  -H 'Content-Type: application/json' --data-binary @/tmp/so.json || true
head -c 1200 /tmp/so.out; echo

echo "=== 计费日志 ==="
docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B' <<'SQL' 2>/dev/null
SELECT id, token_name, model_name, prompt_tokens, completion_tokens, quota, FROM_UNIXTIME(created_at) FROM logs ORDER BY id DESC LIMIT 3;
SELECT id, platform, status, LEFT(fail_reason,120), FROM_UNIXTIME(created_at) FROM tasks ORDER BY id DESC LIMIT 3;
SQL
