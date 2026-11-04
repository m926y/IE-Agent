/* R60 UI 电池的桩上游模型（node --require 注入，拦截 fetch，不真调外部模型）。
 * 三段判定：① 课程编写请求 → 返回真实结构的 editable_course_v1 JSON；② 回答审计请求 → 仅当"声称已生成清单且本轮清单数为 0"才判幻觉；
 * ③ 聊天请求 → 按最后一句用户话选择受控工具，已回传工具结果后出一句短结论（带 700ms 延迟，便于界面断言"思考中"气泡）。 */
const real = globalThis.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const speak = (content) => json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
const callTool = (name, args) => json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ id: 'u1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (!url.startsWith('https://r60-ui-stub.invalid')) return real(input, init);
  let payload = {};
  try { payload = JSON.parse(String((init && init.body) || '{}')); } catch { return speak('无法解析请求。') }
  const msgs = Array.isArray(payload.messages) ? payload.messages : [];
  const system = String((msgs[0] && msgs[0].content) || '');
  const users = msgs.filter((m) => m && m.role === 'user').map((m) => String(m.content || ''));
  const lastUser = users.length ? users[users.length - 1] : '';
  if (system.startsWith('你是驾驶安全培训课程编写助手')) {
    const course = {
      text: '课程正文：连续驾驶不得超过 4 小时；出现困倦立即安全停车休息不少于 20 分钟，并报告调度。夜间行车应加大跟车距离。',
      questions: [
        { type: 'single', title: '连续驾驶的最长时限是？', options: ['2 小时', '4 小时', '8 小时'], answer: [1], explain: '实施条例规定的连续驾驶上限。' },
        { type: 'multiple', title: '出现哪些信号应立即停车休息？', options: ['频繁哈欠', '眼皮沉重', '车辆跑偏', '提速赶路'], answer: [0, 1, 2], explain: '困倦信号出现即应中断驾驶。' },
        { type: 'text', title: '写出你本班的疲劳应对计划。', options: [], answer: [], reference: '提前安排可停车休息点，困倦即停并报告。' },
      ],
    };
    return speak(JSON.stringify(course));
  }
  if (system.startsWith('你是平台回答审计智能体')) {
    const claimed = /已为你生成待确认清单|已生成培训清单|已生成分销/.test(lastUser);
    const zeroPlans = /"确认清单数":\s*0/.test(lastUser);
    return speak(claimed && zeroPlans ? '{"hallucination":true,"problems":["回答声称已生成确认清单，但本轮工具没有产出任何清单"]}' : '{"hallucination":false,"problems":[]}');
  }
  if (msgs.some((m) => m && m.role === 'tool')) { await sleep(700); return speak('已按工具返回的真实结果说明（本轮未写入任何数据）。'); }
  if (/假装已生成/.test(lastUser)) return speak('已为你生成待确认清单，请点击下方按钮确认。');
  const mup = lastUser.match(/upload_id=(aiu-[a-f0-9]{24})/);
  const name = /批量创建账号|按表格/.test(lastUser) ? 'prepare_account_import_from_upload'
    : /生成.*课程|据文件|出题/.test(lastUser) ? 'prepare_course_from_upload'
      : /发放培训|分配培训|创建培训任务/.test(lastUser) ? 'prepare_training_batch' : 'get_tasks';
  const args = name === 'prepare_training_batch' ? { course_id: 'CRS_R60', cohort: 'all', due_at: '2099-01-01' }
    : name === 'get_tasks' ? {} : { upload_id: mup ? mup[1] : '' };
  return callTool(name, args);
};
