// R60 云端聊天附件的前端契约（组件静态渲染 + 源码/CSS 约定；不依赖浏览器）。
// 真实浏览器电池见 scripts/r60-ai-cloud-battery.cjs（本沙箱 Chromium 启动即退出，故本轮以本文件为门禁）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const src = (f) => readFile(root + '/src/' + f, 'utf8');

test('AI attachment UI contract (R60)', async (t) => {
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  /* 产物必须落在仓库内（.runtime-tmp 已被 .gitignore 排除），否则被 bundle 的外部依赖（fflate）解析不到 */
  await mkdir(root + '/.runtime-tmp', { recursive: true });
  const tmpDir = await mkdtemp(root + '/.runtime-tmp/r60-ui-');
  const mod = join(tmpDir, 'agent-tools.mjs');
  await build({ entryPoints: [root + '/src/agent-tools.tsx'], outfile: mod, bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic' });
  const { AgentCredentials } = await import('file://' + mod);

  await t.test('一次性口令表：标明不留存、可另存、绝不出现服务器下载链接', () => {
    const html = renderToStaticMarkup(React.createElement(AgentCredentials, { items: [
      { username: 'r60_ui_new', display_name: '上岗司机', role: 'driver', initial_password: 'Abc-123_x', vehicle: '车辆2' },
      { username: 'r60_ui_ofc', display_name: '上岗安全员', role: 'safety_officer', initial_password: 'Def-456_x', vehicle: '未绑定' },
    ] }));
    assert.match(html, /初始口令（仅此一次显示，服务端不留存）/);
    assert.match(html, /r60_ui_new/);
    assert.match(html, /Abc-123_x/, '口令要显示给操作人一次');
    assert.match(html, /上岗司机|司机/, '角色用中文');
    assert.match(html, /下载一次性口令表/);
    assert.match(html, /遗漏的账号/, '必须给出口令遗失后的正确做法');
    assert.ok(!/\/api\/agent\/credentials/.test(html), '云端不提供服务器端口令文件');
  });

  await t.test('上传入口与思考中状态按云端能力表述', async () => {
    const app = await src('App.tsx');
    assert.match(app, /aria-label="上传文件"/, '输入框左侧要有上传按钮');
    assert.match(app, /accept="\.xlsx,\.csv,\.docx,\.pptx,\.html,\.htm,\.md,\.txt"/, '接受格式与云端解析能力一致（无 PDF）');
    assert.match(app, /atts\.length >= 3/, '每条消息最多 3 个附件');
    assert.match(app, /思考中，正在查询数据并整理回答/, '发送后即出"思考中"气泡');
    assert.match(app, /className="ai-att-chip">📎 \{a\.name\}<em>\{a\.kind_label\} · \{a\.chars\}字/, '用户消息显示 文件名·类型·字数');
    assert.match(app, /pdf_not_supported_hosted/, 'PDF 有专门的诚实说明文案');
    assert.match(app, /attachment_expired/, '附件过期要单独提示重新上传');
    assert.match(app, /m\.audit/, '审计智能体更正提示参与渲染');
    const api = await src('api.ts');
    assert.match(api, /"\/api\/ai\/upload"/);
    assert.match(api, /x-file-name/, '文件名用头传递（原始字节流）');
    assert.match(api, /attachments\?:string\[\]/, '聊天请求携带附件 id 列表');
  });

  await t.test('R61 评分口径云端只读视图与司机待办一键收起', async () => {
    const weights = await src('weights.tsx');
    assert.match(weights, /state\.hosted_readonly/, '权重页要有云端只读分支');
    assert.match(weights, /当前使用的评分权重/);
    assert.ok(!/云端/.test(weights), 'R62：权重页不再出现"云端"小字（属主要求）');
    assert.match(weights, />只读</, '标记只读，不给可点的重算按钮');
    const rules = await src('model-rules.tsx');
    assert.match(rules, /s\.hosted_readonly/, '模型规则页要有云端只读分支');
    assert.match(rules, /模型因子与参考口径（只读）/);
    assert.match(rules, /本地完整数据工作台按草案→审核→生效执行/);
    const drv = await src('driver-notifications.tsx');
    assert.match(drv, /一键收起/, '司机端待办提供一键收起');
    assert.match(drv, /aria-expanded/, '收起状态对读屏可感知');
    assert.match(drv, /aria-controls="driver-todo-items"/);
    assert.match(drv, /不延长任何截止时间|不延长任何截止时间/, '收起不得改变业务时限');
    assert.match(drv, /优先处理|dt-group/, '待办按紧迫感分组');
    assert.match(drv, /dt-skeleton|dt-empty/, '读取中与空态有专门呈现（不再长时间空白）');
    const ratio = await src('overview-controls.tsx');
    assert.match(ratio, /const readOnly = Boolean\(state\?\.hosted_readonly\)/);
    assert.ok(ratio.indexOf('const readOnly') < ratio.indexOf('disabled={busy || readOnly}'), 'readOnly 必须在使用前声明（避免再次 TDZ 白屏）');
    assert.match(ratio, /readOnly&&<span className="tag blue">只读<\/span>/);
    const css = await readFile(root + '/src/driver-integrated.css', 'utf8');
    assert.match(css, /\.driver-todo\.is-folded #driver-todo-items\{display:none\}/);
    assert.match(css, /prefers-reduced-motion/);
    assert.equal(css.includes('.driver-todo-list'), false, '旧类名规则应清理掉');
  });

  await t.test('R60 一并补齐的云端入口：台账勾选删除与账号删除', async () => {
    const ui = await src('training-ui.tsx');
    assert.match(ui, /export function useTaskDeletionPermission/);
    assert.match(ui, /\/api\/training-tasks\/batch-delete/);
    assert.match(ui, /answered_with_facts:'学习摘要已生成'/, '处理记录状态要中文化');
    assert.match(ui, /deleted:'已删除'/);
    const admin = await src('admin.tsx');
    assert.match(admin, /非本人创建|安全员只能删除自己创建的任务/, '界面要说明安全员的删除范围');
    assert.match(admin, /className="td-check"/, '勾选框必须在台账表格里（R62：不再单独做一栏）');
    assert.match(admin, /<th className="td-check-col">/, '表头要有全选框');
    assert.ok(!/ledger-pick-list/.test(admin), '旧的独立勾选面板应已移除');
    assert.match(admin, /window\.confirm\(`确认删除选中的/, '批量删除必须二次确认');
    assert.match(admin, /expected_updated_at/, '删除按任务版本校验，不静默覆盖');
    assert.match(admin, /历史学习记录|历史记录/);
    const data = await src('data.tsx');
    assert.ok(!/云端数据装配口径说明/.test(data), 'R62：数据中心的云端口径长段小字提示已去掉');
    assert.ok(!/（云端未导入该数据源）/.test(data), '下拉项不再挂"云端"括号提示');
    const table = await src('ui.tsx');
    assert.ok(!/\{hostedNote && <p className="meta">\{hostedNote\}<\/p>\}/.test(table), '表格下方不再刷口径小字（服务端字段仍返回）');
    const accounts = await src('sm18.tsx');
    assert.match(accounts, /"\/api\/admin\/users\/" \+ encodeURIComponent/, '账号删除要有入口');
    assert.match(accounts, /cannot_delete_self|不能删除当前登录的账号/);
    assert.match(accounts, /method: "DELETE"/);
    const server = await readFile(root + '/server.mjs', 'utf8');
    assert.match(server, /path: "\/api\/training-tasks\/batch-delete"/);
    assert.match(server, /officer_can_only_delete_own_tasks/);
    assert.match(server, /cannot_delete_last_admin/);
  });

  await t.test('CSS：动画圆点与减弱动画偏好', async () => {
    const css = await src('ai-message.css');
    assert.match(css, /\.ai-thinking-dots i \{[^}]*animation: ai-dot/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\.ai-att-chip em/);
    assert.match(css, /\.agent-credentials /);
  });
});
