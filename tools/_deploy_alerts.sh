#!/bin/bash
# 部署告警系统到 /opt/commandcode-proxy（LF 归一化 + 语法预检 + 构建 + 健康验证 + 失败回滚）
set -uo pipefail

DIR=/opt/commandcode-proxy
STAGE=/tmp/cc-deploy
TS=$(date +%Y%m%d-%H%M%S)
BAK=/root/cc-alert-backup-$TS
FILES="proxy.mjs alerts.mjs index.html admin.js admin.css Dockerfile README_zh.md README.md"

echo "=== 1) 备份到 $BAK ==="
mkdir -p "$BAK"
for f in $FILES; do cp -a "$DIR/$f" "$BAK/$f" 2>/dev/null || echo "  (无 $f)"; done
cp -a "$DIR/docker-compose.override.yml" "$BAK/docker-compose.override.yml"
ls -la "$BAK" | tail -12

echo "=== 2) LF 归一化并落位 ==="
for f in $FILES; do
  tr -d '\r' < "$STAGE/$f" > "$DIR/$f"
  chmod 644 "$DIR/$f"
done
mkdir -p "$DIR/test" "$DIR/tools"
tr -d '\r' < "$STAGE/alerts.test.mjs" > "$DIR/test/alerts.test.mjs"
tr -d '\r' < "$STAGE/helpers.mjs"     > "$DIR/test/helpers.mjs"
tr -d '\r' < "$STAGE/fake-smtp.mjs"   > "$DIR/tools/fake-smtp.mjs"
chmod 644 "$DIR/test/alerts.test.mjs" "$DIR/test/helpers.mjs" "$DIR/tools/fake-smtp.mjs"
md5sum "$DIR/proxy.mjs" "$DIR/alerts.mjs" "$DIR/admin.js" "$DIR/index.html"
grep -c $'\r' "$DIR/Dockerfile" || true   # 期望 0（Dockerfile 不能有 CRLF）

echo "=== 3) 语法预检（临时 node 容器） ==="
docker run --rm -v "$DIR":/app:ro -w /app node:22-alpine sh -c 'node --check proxy.mjs && node --check alerts.mjs && node --check admin.js && echo "syntax OK"' || {
  echo "!! 语法预检失败，回滚文件"; for f in $FILES; do cp -a "$BAK/$f" "$DIR/$f"; done; exit 1; }

echo "=== 4) 注入告警环境变量（管理台地址/主机标识） ==="
python3 - <<'PY'
p = '/opt/commandcode-proxy/docker-compose.override.yml'
s = open(p, encoding='utf-8').read()
if 'CC_ADMIN_URL' not in s:
    s = s.replace('CC_MAX_INFLIGHT: "8"',
                  'CC_MAX_INFLIGHT: "8"\n      CC_ADMIN_URL: "https://ai.lu-k.cn/proxy/"\n      CC_HOST_LABEL: "ai.lu-k.cn"', 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('override 已更新')
else:
    print('override 已包含 CC_ADMIN_URL，跳过')
PY
grep -n -E 'CC_ADMIN_URL|CC_HOST_LABEL|CC_MAX_INFLIGHT' "$DIR/docker-compose.override.yml"

echo "=== 5) 构建镜像 ==="
cd "$DIR" || exit 1
docker compose build proxy 2>&1 | tail -15 || {
  echo "!! 构建失败，回滚"; for f in $FILES; do cp -a "$BAK/$f" "$DIR/$f"; done
  cp -a "$BAK/docker-compose.override.yml" "$DIR/docker-compose.override.yml"
  docker compose build proxy >/dev/null 2>&1; docker compose up -d proxy >/dev/null 2>&1; exit 1; }

echo "=== 6) 重建容器 ==="
docker compose up -d proxy 2>&1 | tail -5

echo "=== 7) 健康验证 ==="
ok=0
for i in $(seq 1 30); do
  sleep 2
  if curl -s -m 4 http://127.0.0.1:3050/health | grep -q OK; then ok=1; break; fi
done
if [ "$ok" != "1" ]; then
  echo "!! 健康检查失败，回滚到 $BAK"
  docker logs --tail 40 commandcode-proxy-proxy-1 2>&1
  for f in $FILES; do cp -a "$BAK/$f" "$DIR/$f"; done
  cp -a "$BAK/docker-compose.override.yml" "$DIR/docker-compose.override.yml"
  docker compose build proxy >/dev/null 2>&1
  docker compose up -d proxy >/dev/null 2>&1
  sleep 6
  echo "回滚后健康: $(curl -s -m 4 http://127.0.0.1:3050/health)"
  exit 1
fi
echo "健康检查通过"

echo "=== 8) 新接口验证 ==="
curl -s -m 6 http://127.0.0.1:3050/admin/api/alerts | head -c 400; echo
echo "--- 容器状态 ---"
docker compose ps --format '{{.Name}} {{.Status}}'
echo "--- 启动日志（告警相关） ---"
docker logs --tail 60 commandcode-proxy-proxy-1 2>&1 | grep -E 'alert|Proxy started' | tail -12
echo "--- 数据目录 ---"
ls -la "$DIR/data"
echo "=== 完成（备份：$BAK） ==="
