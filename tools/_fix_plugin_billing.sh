#!/bin/bash
# 插件计费表达式：直接用正确复合键覆盖（typesafe::model）；顺便演示读 JSON 要用 HEX
python3 - <<'PY'
import json, subprocess, sys

MYSQL = 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api'

def run(sql, tuples_only=True):
    flags = ' -N -B' if tuples_only else ''
    p = subprocess.run(['docker', 'exec', '-i', 'new-api-mysql', 'sh', '-c', MYSQL + flags],
                       input=sql.encode('utf-8'), capture_output=True)
    if p.returncode != 0:
        print('SQL 失败:', p.stderr.decode('utf-8', 'replace')[:400]); sys.exit(1)
    return p.stdout.decode('utf-8', 'replace')

def H(s):
    return "CONVERT(0x%s USING utf8mb4)" % s.encode('utf-8').hex().upper()

MODELS = ['jev-latest', 'jev-preview', 'jev-1.13.0', 'jev']
EXPR = 'tier("base", u("input_tokens") * 0.04 / 1000000)'
OPT = 'billing_setting.plugin_billing_expr'

# 读旧值：一定要走 HEX，mysql 批处理会把 JSON 里的 \" 转义坏
hex_cur = run(f"SELECT HEX(value) FROM options WHERE `key`='{OPT}';").strip()
cur = bytes.fromhex(hex_cur).decode('utf-8') if hex_cur else ''
print('现在库里的值 =', cur[:300])

data = {'typesafe::' + m: EXPR for m in MODELS}
payload = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
if cur:
    run(f"UPDATE options SET value={H(payload)} WHERE `key`='{OPT}';", tuples_only=False)
else:
    run(f"INSERT INTO options (`key`, value) VALUES ('{OPT}', {H(payload)});", tuples_only=False)

back = bytes.fromhex(run(f"SELECT HEX(value) FROM options WHERE `key`='{OPT}';").strip()).decode('utf-8')
print('写回校验 =', back)
print('解析校验 =', json.loads(back))
PY

echo "=== 重启 new-api ==="
docker restart new-api >/dev/null 2>&1
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3000/api/status 2>/dev/null)
  [ "$code" = "200" ] && { echo "new-api 就绪（${i}s）"; break; }
  sleep 1
done
sleep 2

echo "=== 冒烟：POST /v1/systemone ==="
curl -sS -m 90 -o /tmp/so3.out -w 'HTTP %{http_code}\n' -X POST https://ai.lu-k.cn/v1/systemone \
  -H "Authorization: Bearer ${CC_SITE_TOKEN}" \
  -H 'Content-Type: application/json' --data-binary @/tmp/so.json || true
head -c 1600 /tmp/so3.out; echo

echo "=== 计费 / task 日志 ==="
docker exec -i new-api-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api -N -B' <<'SQL' 2>/dev/null
SELECT id, token_name, model_name, prompt_tokens, completion_tokens, quota, FROM_UNIXTIME(created_at) FROM logs ORDER BY id DESC LIMIT 3;
SELECT id, platform, status, LEFT(fail_reason,140) FROM tasks ORDER BY id DESC LIMIT 3;
SQL
