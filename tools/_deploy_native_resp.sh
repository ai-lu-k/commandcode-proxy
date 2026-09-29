#!/bin/bash
# 部署「原生响应」版本，并验证：直连原生端点 + 走站点计费
cd /opt/commandcode-proxy
docker compose build proxy >/dev/null 2>&1
docker compose up -d proxy 2>&1 | tail -2
sleep 4
docker compose ps --no-trunc 2>/dev/null | tail -2

M() { docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B'; }

echo "=== 1) 直连代理原生端点（应无 choices，只有 model/answers/usage） ==="
curl -sS -m 90 -X POST http://127.0.0.1:3050/provider/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{"model":"typesafe/jev","state":"直连测试：付款三天失败，也没人回复","questions":{"is_urgent":{"type":"noul","instructions":"是否需要紧急处理？"},"department":{"type":"choice","instructions":"哪个团队处理？","criteria":{"billing":"付款发票退款","technical":"故障","sales":"定价升级"}}}}' | head -c 700
echo

echo "=== 2) 走站点（newapi → 原生端点，计费） ==="
curl -sS -m 90 -o /tmp/nat.out -w 'HTTP %{http_code}\n' -X POST https://ai.lu-k.cn/v1/chat/completions \
  -H "Authorization: Bearer ${CC_SITE_TOKEN}" \
  -H 'Content-Type: application/json' -d @/tmp/t19c.json || true
head -c 700 /tmp/nat.out; echo

echo "=== 3) 计费日志 ==="
echo "SELECT id, token_name, model_name, prompt_tokens, completion_tokens, quota, FROM_UNIXTIME(created_at) FROM logs WHERE model_name LIKE '%jev%' ORDER BY id DESC LIMIT 2;" | M 2>/dev/null
