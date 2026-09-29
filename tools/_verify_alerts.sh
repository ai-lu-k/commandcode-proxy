#!/bin/bash
# 部署后验证：newapi→proxy 网络、状态文件、公网入口、容器内跑测试套件
echo "=== 1) newapi 容器能否按容器名访问重建后的 proxy（真实调用链依赖这条） ==="
docker exec new-api sh -c 'wget -qO- --timeout=6 http://commandcode-proxy-proxy-1:3050/health' 2>&1 || echo "!! newapi 访问失败"
echo
echo "=== 2) 等 20s 让启动体检跑完，看状态文件与告警结果 ==="
sleep 20
ls -la /opt/commandcode-proxy/data/
echo "--- alerts 摘要 ---"
curl -s -m 6 http://127.0.0.1:3050/admin/api/alerts | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('enabled:', d['enabled'], '| 通道:', 'log-only' if d['config']['effective']['logOnly'] else 'configured')
print('池: 共', d['pool']['total'], '可用', d['pool']['usable'])
print('counters:', json.dumps(d['counters'], ensure_ascii=False))
for a in d['active']:
    print(' ACTIVE', a['level'], a['title'], '|', a['detail'][:80])
for h in d['history']:
    print(' HIST', h['status'], h['level'], h['title'])
"
echo "=== 3) 公网入口（经 nginx + 网关，带 basic auth） ==="
# 凭据从环境变量取，别写进仓库：CC_ADMIN_USER / CC_ADMIN_PASS
AUTH=()
if [ -n "${CC_ADMIN_PASS:-}" ]; then AUTH=(-u "${CC_ADMIN_USER:-<ADMIN_USER>}:${CC_ADMIN_PASS}"); fi
curl -s -o /dev/null -w '  /proxy/                      -> %{http_code}\n' -m 8 https://ai.lu-k.cn/proxy/
curl -s -o /dev/null -w '  /proxy/admin/api/alerts    -> %{http_code}\n' -m 8 "${AUTH[@]}" https://ai.lu-k.cn/proxy/admin/api/alerts
curl -s -o /dev/null -w '  /admin/api/alerts          -> %{http_code}\n' -m 8 "${AUTH[@]}" https://ai.lu-k.cn/admin/api/alerts
curl -s -o /dev/null -w '  /v1/models (站点)          -> %{http_code}\n' -m 10 https://ai.lu-k.cn/v1/models
echo "=== 4) 容器内跑完整测试套件（含新增告警用例，真实走请求链路） ==="
docker run --rm -v /opt/commandcode-proxy:/app -w /app node:22-alpine \
  sh -c 'node --test test/*.test.mjs 2>&1 | tail -12'
echo "=== 5) 最近日志 ==="
docker logs --tail 25 commandcode-proxy-proxy-1 2>&1 | tail -25
