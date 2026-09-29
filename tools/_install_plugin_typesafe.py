#!/usr/bin/env python3
# 安装 new-api-plugin-typesafe（Task Plugin）+ 建渠道(61) + 能力行 + 插件计费表达式
# 运行位置：服务器（宿主机），通过 docker exec 进 mysql
import base64
import hashlib
import json
import subprocess
import sys
import time

SRC = '/tmp/ts-plugin.js'
ICON = '/tmp/ts-icon.svg'
PLUGIN_KEY = 'typesafe'
PLUGIN_VERSION = '1.1.1'
CHANNEL_NAME = 'jev决策(插件)'
BASE_URL = 'http://commandcode-proxy-proxy-1:3050/provider'   # 插件会打 {baseUrl}/v1/systemone
CHANNEL_KEY = 'sk-proxy-internal'                             # 代理原生端点不校验，占位即可
MODELS = ['jev-latest', 'jev-preview', 'jev-1.13.0', 'jev']
UPSTREAM_MODEL = 'typesafe/jev'
GROUP = '特惠'
PRICE_PER_M = 0.04                                            # CC 官方价 $0.04/M 输入，输出免费

MYSQL = 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" new_api'


def run(sql, tuples_only=True):
    flags = ' -N -B' if tuples_only else ''
    p = subprocess.run(['docker', 'exec', '-i', 'new-api-mysql', 'sh', '-c', MYSQL + flags],
                       input=sql.encode('utf-8'), capture_output=True)
    if p.returncode != 0:
        print('SQL 失败:', p.stderr.decode('utf-8', 'replace')[:500])
        sys.exit(1)
    return p.stdout.decode('utf-8', 'replace')


def H(s):
    """CJK / JSON 一律用十六进制字面量，避开 collation(1267) 与转义问题"""
    return "CONVERT(0x%s USING utf8mb4)" % s.encode('utf-8').hex().upper()


def name_match(s):
    """CJK 比较走 HEX()，否则 MySQL 8 会报 Illegal mix of collations"""
    return "HEX(name)='%s'" % s.encode('utf-8').hex().upper()


def esc(s):
    return "'" + str(s).replace('\\', '\\\\').replace("'", "\\'") + "'"


src = open(SRC, encoding='utf-8').read()
sha = hashlib.sha256(src.encode('utf-8')).hexdigest()
icon_uri = 'data:image/svg+xml;base64,' + base64.b64encode(open(ICON, 'rb').read()).decode()
print('plugin sha256 =', sha, '(index 期望 e8ff5ad1fcf8794eb49358bdf438720c4b55e63d5b4639158c9ce72d4bff048b)')

# ── 1) 插件本体 ─────────────────────────────────────
run(f"""INSERT INTO task_plugins (`key`, api_version, version, source, source_hash, icon, enabled, active, created_at, remark)
VALUES ({esc(PLUGIN_KEY)}, 1, {esc(PLUGIN_VERSION)}, {H(src)}, {esc(sha)}, {H(icon_uri)}, 1, 1, {int(time.time())}, {esc('installed via cli')})
ON DUPLICATE KEY UPDATE source=VALUES(source), source_hash=VALUES(source_hash), icon=VALUES(icon), enabled=1, active=1;""", tuples_only=False)
print('--- task_plugins ---')
print(run("SELECT id, `key`, api_version, version, enabled, active, LENGTH(source), LEFT(source_hash,12) FROM task_plugins;"))

# ── 2) 渠道（type 61 Task Plugin）────────────────────
mapping = json.dumps({m: UPSTREAM_MODEL for m in MODELS}, ensure_ascii=False, separators=(',', ':'))
setting = json.dumps({
    'task_plugin_key': PLUGIN_KEY,
    'force_format': False, 'thinking_to_content': False, 'proxy': '',
    'pass_through_body_enabled': False, 'responses_websocket_enabled': False,
    'system_prompt': '', 'system_prompt_override': False,
}, ensure_ascii=False, separators=(',', ':'))

run(f"DELETE FROM channels WHERE {name_match(CHANNEL_NAME)};", tuples_only=False)
run(f"""INSERT INTO channels (`type`, `key`, status, name, weight, created_time, base_url, models, `group`, model_mapping, priority, auto_ban, setting, remark)
VALUES (61, {esc(CHANNEL_KEY)}, 1, {H(CHANNEL_NAME)}, 1, {int(time.time())}, {esc(BASE_URL)}, {esc(','.join(MODELS))}, {H(GROUP)}, {H(mapping)}, 0, 1, {H(setting)}, {esc('plugin: typesafe')});""", tuples_only=False)
cid = run(f"SELECT id FROM channels WHERE {name_match(CHANNEL_NAME)};").strip()
if not cid:
    print('渠道没建出来'); sys.exit(1)
print('--- channel ---')
print(run(f"SELECT id, type, base_url, models, HEX(`group`), status, setting FROM channels WHERE id={cid};"))
print('channel id =', cid)

# ── 3) 能力行（裸 SQL 不会触发 newapi 重建 abilities）──
run(f"DELETE FROM abilities WHERE channel_id={cid};", tuples_only=False)
vals = ','.join(f"({H(GROUP)}, {esc(m)}, {cid}, 1, 0, 0)" for m in MODELS)
run(f"INSERT INTO abilities (`group`, model, channel_id, enabled, priority, weight) VALUES {vals};", tuples_only=False)
print('--- abilities ---')
print(run(f"SELECT HEX(`group`), model, channel_id, enabled FROM abilities WHERE channel_id={cid};"))

# ── 4) 插件计费 ─────────────────────────────────────
expr = f'tier("base", u("input_tokens") * {PRICE_PER_M} / 1000000)'
for opt, value in (('billing_setting.plugin_billing_expr', expr),
                   ('billing_setting.billing_mode', 'tiered_expr')):
    cur = run(f"SELECT value FROM options WHERE `key`={esc(opt)};").strip()
    data = {}
    if cur:
        try:
            data = json.loads(cur)
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}
    for m in MODELS:
        data[m] = value
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    if cur:
        run(f"UPDATE options SET value={H(payload)} WHERE `key`={esc(opt)};", tuples_only=False)
    else:
        run(f"INSERT INTO options (`key`, value) VALUES ({esc(opt)}, {H(payload)});", tuples_only=False)
    print(opt, '->', payload[:400])

print('--- 其它 jev 相关渠道/能力残留 ---')
print(run("SELECT id, type, base_url, models, HEX(name), status FROM channels WHERE models LIKE '%jev%';"))
print(run("SELECT HEX(`group`), model, channel_id, enabled FROM abilities WHERE model LIKE '%jev%';"))
