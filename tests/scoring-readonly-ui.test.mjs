// R61 回归：云端"评分规则"页必须能打开且只显示当前使用权重。
// 上一版把只读分支内联在 WeightEditor 里、用到的 colors 常量声明在其之后 → TDZ ReferenceError 整页白屏，
// 因此这里用真实静态渲染执行两个只读视图（不是只查字符串）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const DIMS = [{ key: 'history', name: '历史事故与未遂' }, { key: 'fatigue_distraction', name: '疲劳与分心' }, { key: 'driving_stability', name: '驾驶稳定性' }, { key: 'road_rule', name: '道路规则风险' }, { key: 'management', name: '管理配合度' }, { key: 'imu_evidence', name: 'IMU风险佐证' }];
const WEIGHTS = { history: 0.26599176948568987, fatigue_distraction: 0.139679, driving_stability: 0.26599176948568987, road_rule: 0.07383197351173076, management: 0.15450512206513758, imu_evidence: 0.1 };
const STATE = {
  hosted_readonly: true, hosted_note: '云端工作台只显示当前生效的权重与口径，不在此页预览、重算或生效。',
  weights: WEIGHTS, baseline_weights: WEIGHTS, dimensions: DIMS, designs: [], versions: [],
  active_version: 'original', ordinal: 0, window_days: 14, half_life_days: 14,
  dimension_windows: { history: 14, fatigue_distraction: 1, driving_stability: 14, road_rule: 14, management: 14, imu_evidence: 14 },
  ruleset_versions: { history: 'snapshot_ffbc02143fcb', fatigue_distraction: 'ruleset_v13_20261102', driving_stability: 'snapshot_ffbc02143fcb', road_rule: 'snapshot_ffbc02143fcb', management: 'snapshot_ffbc02143fcb', imu_evidence: 'snapshot_ffbc02143fcb' },
  factors: [{ key: 'history', name: '历史事故与未遂', unit: 'per_1000km', condition: '', events: [{ code: 11803, name: '事故', severity: 10 }] }],
  reference: { history: { tau: 1.2, mu: 0.02, rate_scale: 1 } },
  model_config: { window_days: 14, half_life_days: 14, factors: [{ code: 11803, name: '事故', dimension: 'history', severity: 10 }], reference: { history: { tau: 1.2, mu: 0.02, rate_scale: 1 } } },
  vehicle_count: 500,
};

test('cloud scoring pages render read-only without crashing (R61)', async t => {
  await mkdir(root + '/.runtime-tmp', { recursive: true });
  const dir = await mkdtemp(root + '/.runtime-tmp/r61-ui-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = {};
  for (const name of ['weights', 'model-rules']) {
    const file = join(dir, name + '.mjs');
    await build({ entryPoints: [root + '/src/' + name + '.tsx'], outfile: file, bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic' });
    out[name] = await import('file://' + file);
  }
  const render = (el) => renderToStaticMarkup(el);

  await t.test('权重页只读视图渲染当前六维权重，无任何重算入口或服务不可用文案', () => {
    const html = render(React.createElement(out.weights.HostedWeightView, { state: STATE }));
    assert.match(html, /当前使用的评分权重/);
    assert.match(html, />只读</);
    assert.match(html, /26\.6%/);
    assert.match(html, /13\.97%/, '非整数权重保留两位小数，不四舍五入成整数');
    assert.match(html, /history|历史事故与未遂/);
    assert.match(html, /snapshot_ffbc02143fcb/);
    assert.match(html, /疲劳与分心[\s\S]*?1[\s\S]*?ruleset_v13_20261102/, '各维度自身窗口与版本如实展示');
    assert.match(html, /覆盖 500 辆车/);
    assert.match(html, /生效口径版本/, '每维度标注生效口径版本');
    for (const bad of ['重算服务', '暂不可用', '不可用', '提交并重算', '预览模型规则变化', '确认生效']) assert.ok(!html.includes(bad), '只读页不得出现：' + bad);
    assert.ok(!/<input|<textarea/.test(html), '只读页不渲染可编辑控件');
  });

  await t.test('模型规则页只读视图渲染口径并可折叠因子', () => {
    const html = render(React.createElement(out['model-rules'].HostedModelRulesView, { state: STATE }));
    assert.match(html, /模型因子与参考口径（只读）/);
    assert.match(html, /观察窗口 14 天/);
    assert.match(html, /时间半衰期 14 天/);
    assert.match(html, /权重合计 100\.00%/);
    assert.match(html, /11803/);
    assert.match(html, /小样本平滑强度/);
    assert.match(html, /本页只提供查看/);
    for (const bad of ['重算服务', '暂不可用']) assert.ok(!html.includes(bad), '只读页不得出现：' + bad);
  });

  await t.test('冻结模型文件缺失时不卡住、不编造数字', () => {
    const bare = { ...STATE, model_config: null, factors: [], reference: null, window_days: null, half_life_days: null };
    delete bare.model_config;
    const html = render(React.createElement(out['model-rules'].HostedModelRulesView, { state: bare }));
    assert.match(html, /因子与参考口径文件未随本次运行交付/);
    assert.match(html, /不以估算值填充/);
    assert.ok(!/读取中|正在读取/.test(html), '不得停在"读取中"（表现为页面打不开）');
    const w = render(React.createElement(out.weights.HostedWeightView, { state: { ...bare, dimension_windows: {}, window_days: null } }));
    assert.match(w, /—/, '窗口缺数据时显示"—"而不是 0');
    assert.match(w, /26\.6%/);
  });

});
