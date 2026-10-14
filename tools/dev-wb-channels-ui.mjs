// 本地起一个带内容的渠道池实例，供浏览器检查渲染用（不属于测试套件）。
// 跑法：node dev-wb-channels-ui.mjs   —— 它会一直挂着，Ctrl-C 结束。
import { createServer } from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PORT = 3900;
const dir = mkdtempSync(join(tmpdir(), 'wbui-'));
const keysFile = join(dir, 'keys.json');
const okBody = { id: 'x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'ok' } }] };

function stub(handler) {
  return new Promise((r) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => r({ server: s, port: s.address().port }));
  });
}

const fast = await stub((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url.startsWith('/v1/models') ? { object: 'list', realm: 'intl', data: [{ id: 'deepseek-v4.1-flash' }] } : okBody));
});
const slow = await stub((req, res) => {
  setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(okBody)); }, 1600);
});

writeFileSync(keysFile, JSON.stringify({
  lb: {}, settings: {}, keys: [],
  wbBreaker: { slowMs: 1000, window: 4, slowCount: 3, errorCount: 2, openMs: 300000, maxOpenMs: 1800000 },
  wbChannels: [
    { id: 'c-intl', name: 'WorkBuddy · 国际版', realm: 'intl', hubUrl: `http://127.0.0.1:${fast.port}`, weight: 5, priority: 0, enabled: true },
    // 熔断由流量自己触发（1600ms 首字 > 1000ms 阈值），截图里能看到真实统计 + 熔断中
    { id: 'c-cn', name: 'WorkBuddy · 国内版', realm: 'cn', hubUrl: `http://127.0.0.1:${slow.port}`, weight: 2, priority: 0, enabled: true },
    { id: 'c-old', name: '旧 hub（已停用）', realm: '', hubUrl: '', weight: 1, priority: -1, enabled: false },
  ],
}, null, 2));

const child = spawn(process.execPath, ['proxy.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), CC_KEYS_FILE: keysFile, HOST: '127.0.0.1', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const api = (p, init) => fetch(`http://127.0.0.1:${PORT}${p}`, init);
for (let i = 0; i < 80; i++) {
  try { await api('/admin/api/wb/channels'); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
}
// 灌一点流量，让首字延迟有数、并让慢渠道自己撞上熔断
for (let i = 0; i < 18; i++) {
  await api('/wb/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
  }).catch(() => {});
}
const view = await (await api('/admin/api/wb/channels')).json();
console.log('READY http://127.0.0.1:' + PORT + '/admin#wb/channels');
for (const c of view.channels) {
  console.log(`  ${c.name} enabled=${c.enabled} breaker=${c.breakerActive} avg=${c.stats.avgTtfbMs}ms slow=${c.stats.slowCount} n=${c.stats.samples}`);
}
console.log('按 Ctrl-C 结束');
process.on('SIGINT', () => { child.kill('SIGKILL'); fast.server.close(); slow.server.close(); process.exit(0); });
