#!/bin/bash
# 部署代理（原生 systemone 端点 + 可读 answers）
set -e
cd /opt/commandcode-proxy
BK=/root/cc-native-backup-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BK"
cp -a proxy.mjs decision.mjs Dockerfile "$BK"/ 2>/dev/null || true
echo "backup: $BK"
ls -l proxy.mjs decision.mjs
node --check proxy.mjs && echo "proxy syntax OK"
node --check decision.mjs && echo "decision syntax OK"
docker compose build proxy
docker compose up -d proxy
sleep 4
docker compose ps
echo "=== start log ==="
docker compose logs --tail=40 proxy | tail -40
echo "=== native endpoint probe ==="
curl -sS -m 65 -o /tmp/native-probe.out -w 'HTTP %{http_code}\n' \
  -X POST http://127.0.0.1:3050/provider/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{"model":"typesafe/jev","state":"测试：付款三天失败，也没人回复","questions":{"is_urgent":{"type":"noul","instructions":"是否需要紧急处理？"},"department":{"type":"choice","instructions":"哪个团队处理？","criteria":{"billing":"付款发票退款","technical":"故障","sales":"定价升级"}}}}' || true
head -c 1200 /tmp/native-probe.out; echo
