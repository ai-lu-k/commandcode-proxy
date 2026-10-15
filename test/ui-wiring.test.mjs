// 管理台静态接线：JS 的选择器必须有对应元素、侧边栏与视图面板必须一一对应、
// 新加的 CSS 类必须有样式、图标引用必须有 symbol。
//
// 这些是「改了 HTML 忘了改 JS（或反过来）」最容易漏的地方，纯文本就能查出来，
// 不需要浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './helpers.mjs';

const html = readFileSync(join(REPO, 'index.html'), 'utf-8');
const js = readFileSync(join(REPO, 'admin.js'), 'utf-8');
const css = readFileSync(join(REPO, 'admin.css'), 'utf-8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
// 有些元素是 JS 自己拼进 DOM 的（登录卡片那两颗按钮），html 里找不到时再在
// admin.js 的模板串里找一遍，两边都没有才算真的写错。
const dynamicIds = new Set([...js.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const sideViews = [...html.matchAll(/<button class="side-item"[^>]*data-view="([^"]+)"/g)].map((m) => m[1]);
const panelViews = [...html.matchAll(/<section class="view-panel"[^>]*data-view="([^"]+)"/g)].map((m) => m[1]);

test('admin.js 里每个 #id 选择器都能找到对应元素', () => {
  const ids = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size > 100, `选择器数量异常：${ids.size}`);
  const missing = [...ids].filter((id) => !htmlIds.has(id) && !dynamicIds.has(id));
  assert.deepEqual(missing, [], `这些选择器没有任何元素：${missing.join(', ')}`);
});

test('侧边栏条目与视图面板一一对应', () => {
  assert.ok(sideViews.length > 0);
  assert.deepEqual(sideViews.filter((v) => !panelViews.includes(v)), [], '有入口没有面板');
  assert.deepEqual(panelViews.filter((v) => !sideViews.includes(v)), [], '有面板没有入口');
  assert.equal(new Set(sideViews).size, sideViews.length, 'data-view 重复');
});

test('旧的单段 hash 仍然映射得到真实视图', () => {
  const block = js.match(/const LEGACY_VIEWS = \{([\s\S]*?)\};/);
  assert.ok(block, '找不到 LEGACY_VIEWS');
  const targets = [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(targets.length > 0);
  assert.deepEqual(targets.filter((v) => !sideViews.includes(v)), []);
});

test('渠道池用到的 CSS 类都有样式', () => {
  const need = [
    '.wb-channels', '.wb-ch', '.wb-ch-acts', '.wb-switch', '.wb-num',
    '.wb-dot.trip', '.wb-chip.trip', '.wb-chip.off', '.wb-fact.bad', '.side-count-alert',
    // 账号池的折叠卡片（默认收起，点头部展开）
    '.wb-acc', '.wb-acc-body', '.wb-acc-caret', '.wb-acc.is-open',
  ];
  // 只要求「这个类名作为独立 token 出现过」，后面的组合选择器（.wb-fact.bad b）
  // 也算数，但不能被更长的类名（.wb-ch-acts 之于 .wb-ch）冒充
  const missing = need.filter((c) => !new RegExp(`${c.replace(/\./g, '\\.')}(?![\\w-])`).test(css));
  assert.deepEqual(missing, [], `缺少样式：${missing.join(', ')}`);
});

test('所有图标引用都有对应 symbol', () => {
  const symbols = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([
    ...[...html.matchAll(/<use href="#([^"]+)"/g)].map((m) => m[1]),
    ...[...js.matchAll(/href="#(i-[a-z-]+)"/g)].map((m) => m[1]),
  ]);
  assert.ok(used.size > 0);
  assert.deepEqual([...used].filter((s) => !symbols.has(s)), []);
});
