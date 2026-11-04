// R63 属主界面要求：复核页只讲业务、根因页数字统一两位小数、回放页风险要"看得见"、全站不残留工程边界小字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const src = async (f) => await readFile(root + '/src/' + f, 'utf8');

test('review / root-cause / replay UI contract (R63)', async t => {
  await t.test('评价复核与数据异议：列表不出现原始编号与技术字段', async () => {
    const admin = await src('admin.tsx');
    const i = admin.index_of ? 0 : admin.indexOf('function EvReview()');
    const block = admin.slice(admin.indexOf('function EvReview()'), admin.indexOf('type ScoreRow'));
    assert.match(block, /columns=\{\["driver_id", "reason_code", "status", "created_at", "handled_at"\]\}/, '列表列固定为业务字段');
    for (const raw of ['request_id', 'score_id', 'evidence_id', 'source_version', 'reviewer_id']) {
      assert.ok(!new RegExp('columns=\\[[^\\]]*' + raw).test(block), `列表列不应包含 ${raw}`);
    }
    assert.match(block, /RR_STATUS_CN/, '状态中文化');
    assert.match(block, /RR_LABEL\[String\(req\.reason_code\)\]/, '申请原因中文化');
    assert.match(block, /技术信息（内部定位与口径版本）/, '原始编号收进折叠的"技术信息"');
    assert.match(block, /n2\(snap\.safety_score\)/, '安全分两位小数');
    assert.match(block, /n2\(l\.allocated_points\)/, '扣分两位小数');
    assert.match(block, /DIM_CN\[String\(l\.dimension\)\]/, '维度用中文名');
    assert.ok(!/className="mono">\{String\(v\.request/.test(block), '详情正文不再直接吐原始 id');
    void i;
  });

  await t.test('根因分析：数值统一两位小数，计数保持整数', async () => {
    const r37 = await src('r37.tsx');
    assert.match(r37, /const n2 = \(v: unknown\)/, '需要统一的两位小数格式化');
    assert.match(r37, /n2\(data\.pool_avg\)/);
    assert.match(r37, /n2\(d\.allocated_points\)/);
    assert.match(r37, /n2\(d\.share_pct\)/);
    assert.match(r37, /n2\(e\.allocated_points\)/);
    assert.match(r37, /n2\(o\.safety_score\)/);
    assert.match(r37, /n2\(o\.allocated_points\)/);
    assert.match(r37, /int\(data\.cohort_count\)/, '对象数仍是整数');
    assert.ok(!/\{data\.pool_avg \?\? "—"\}/.test(r37), '不再裸显示原始均值');
  });

  await t.test('历史事件回放：危险事件有行内标注，播放时有右下角提示', async () => {
    const rr = await src('risk-replay.tsx');
    assert.match(rr, /replay-warning-badge/, '行内风险徽标');
    assert.match(rr, /险情|预警/, '危险等级用中文说清');
    assert.match(rr, /replay-risk-toast/, '播放时右下角风险提示框');
    assert.match(rr, /role="alert" aria-live="assertive"/, '提示框对读屏可达');
    assert.match(rr, /setToast/, '有新风险事件时弹提示');
    assert.match(rr, /toastTimer\.current = window\.setTimeout\(\(\) => setToast\(null\), \d+\)/, '提示会自动收起');
    assert.match(rr, /查看关联告警档案/, '提示框要能跳到对应档案');
    assert.match(rr, /rules\[String\(e\.event_type\)\]/, '严重度来自服务端下发的冻结因子表');
    assert.ok(!/severity >= 6 \? 'red'/.test(rr), '分级不在前端硬编码');
  });

  await t.test('成品化：界面正文不再残留工程边界小字', async () => {
    const files = ['risk-replay.tsx', 'weights.tsx', 'model-rules.tsx', 'overview-controls.tsx', 'data.tsx', 'App.tsx', 'admin.tsx', 'driver-actions.tsx', 'agent-tools.tsx', 'training-ledger.tsx', 'ui.tsx', 'training-ui.tsx'];
    const banned = [/云端工作台/, /本地完整数据工作台.*执行/, /不写任何业务表/, /不生成告警、不写/, /不作为限速判定依据/, /不补造趋势/, /不以 0 冒充/, /本页只提供查看/, /评分链路红线/];
    for (const f of files) {
      const s = await src(f);
      /* 只检查真正渲染出来的文案：跳过注释与 hosted_note 等服务端字段名 */
      const visible = s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/hosted_note|hosted_sources|hosted_extras|hosted_unavailable/.test(l)).join('\n');
      for (const rx of banned) assert.ok(!rx.test(visible), `${f} 仍残留边界小字：${rx}`);
    }
  });

  await t.test('台账勾选并入主表：ResourceTable 不残留未使用的旁路', async () => {
    const ui = await src('ui.tsx');
    assert.ok(!/selection\?:/.test(ui), '未使用的 selection 属性应已回退');
    assert.ok(!/onRows\?:/.test(ui), '未使用的 onRows 属性应已回退');
    assert.ok(!/PageCheck/.test(ui));
  });

  await t.test('简报面板与视图：区间来自服务端实测数据，空简报有诚实一句话（R64）', async () => {
    const dr = await src('daily-report.tsx');
    const adm = await src('admin-driver-reports.tsx');
    assert.match(adm, /daily-reports\/settings/, '管理员简报页要读取服务端下发的数据覆盖区间');
    assert.match(adm, /first_generatable/, '区间用于约束"报告日期"选择');
    assert.match(adm, /daily_report_no_observations|daily_report_date_out_of_range/, '两类拒绝都要有中文提示');
    assert.match(adm, /min=\{range\?\.first_generatable\|\|undefined\}/, '日期输入有下限');
    assert.match(dr, /adminDailyReportSettings\(\)/, '面板读取服务端下发的可生成区间');
    assert.match(dr, /range\?\.first_generatable\|\|undefined/, '日期输入框以下限约束，选不到没有数据的日期');
    assert.match(dr, /daily_report_no_observations|daily_report_date_out_of_range/, '两种拒绝都要有中文提示');
    assert.match(dr, /noObservations/, '无可用观测时整体提示，而不是四张"未取得"卡');
    assert.ok(!/'fleet 未取得'/.test(dr), "不再出现英文字段名 fleet");
    assert.ok(!/'日期未取得'/.test(dr), '英文式"日期未取得"占位已移除');
    assert.match(dr, /每天 \{publishTime\} 后自动为已绑定司机/, '说明使用服务端真实发布时间');
    const api = await src('api.ts');
    assert.match(api, /adminDailyReportSettings/, '客户端有 settings 调用');
  });
});
