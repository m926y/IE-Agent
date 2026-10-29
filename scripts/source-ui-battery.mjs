import { startLocalWorkbench } from "./local-workbench.mjs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root=fileURLToPath(new URL('../.source-tests/',import.meta.url));await mkdir(root,{recursive:true});
const directory=await mkdtemp(join(root,'browser-'));
const output=process.env.QA_OUTPUT_DIR || join(directory,'screenshots');await mkdir(output,{recursive:true});
const work=await startLocalWorkbench({directory});let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  const errors=[],external=[],failures=[];
  async function contextFor(name,width){
    const context=await browser.newContext({viewport:{width,height:900}});
    const account=work.store.accounts.find(x=>x.username===name);
    const login=await context.request.post(work.base+'/api/auth/login',{data:account});assert.equal(login.status(),200);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
    page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).hostname!=='127.0.0.1')external.push(r.url());});
    page.on('response',r=>{if(r.status()>=400)failures.push({path:new URL(r.url()).pathname,status:r.status()});});
    return{context,page,account};
  }
  const admin=await contextFor('local_admin',1280),driver=await contextFor('local_driver',390);
  await driver.page.goto(work.base);await driver.page.getByText('数据来自IE亮剑历史材料',{exact:false}).waitFor();
  assert.equal(await driver.page.getByRole('button',{name:'AI',exact:true}).count(),0);
  const sourceScore=work.store.rows('score_snapshots').find(x=>x.driver_id===driver.account.driver_id);
  await driver.page.getByRole('button',{name:'查看本次评分依据',exact:true}).click();
  await driver.page.getByLabel('本人证据详情').getByText(sourceScore.score_id,{exact:true}).waitFor();
  await driver.page.screenshot({path:join(output,'source-score-mobile.png'),fullPage:true});
  console.log('PASS actual IE亮剑 score and evidence display, no external AI entry');
  const event=work.store.rows('replay_events').find(x=>x.driver_id===driver.account.driver_id);
  await driver.page.getByRole('button',{name:'今日风险',exact:true}).click();await driver.page.getByLabel('风险日期').fill(event.replay_date);
  await driver.page.locator('details[id^="driver-event-"]').first().waitFor();
  assert.equal(await driver.page.getByRole('heading',{name:'人工告警',exact:true}).count(),1);
  await driver.page.screenshot({path:join(output,'source-risk-mobile.png'),fullPage:true});
  console.log('PASS actual historical replay and source-only empty alerts');
  await admin.page.goto(work.base+'/#/tr-courses');
  const course=work.store.rows('training_courses')[0];
  await admin.page.getByRole('row').filter({hasText:course.course_id}).waitFor();
  assert.equal(await admin.page.getByRole('button',{name:'创建草稿课程',exact:true}).count(),0);
  await admin.page.screenshot({path:join(output,'source-courses-pending.png'),fullPage:true});
  assert.ok(work.store.rows('training_courses').every(x=>x.content_status==='demo_draft_requires_team_review'));
  console.log('PASS source courses remain draft before explicit isolated workflow approval');
  for(const next of ['pending_review','approved']){const r=await admin.context.request.post(work.base+'/api/admin/course-review',{data:{course_id:course.course_id,new_status:next,note:'隔离浏览器验收流程操作，不代表专业审核'}});assert.equal(r.status(),200);}
  const assigned=await admin.context.request.post(work.base+'/api/admin/training-assign',{data:{course_id:course.course_id,driver_id:driver.account.driver_id,goal:course.completion_requirement,idempotency_key:'source-browser-acceptance'}});assert.equal(assigned.status(),200);const task=await assigned.json();
  await driver.page.getByRole('button',{name:'培训任务',exact:true}).click();await driver.page.getByRole('button',{name:'打开课程与记录'}).first().click();
  await driver.page.getByText(course.content,{exact:true}).waitFor();
  assert.equal(await driver.page.getByRole('radio').count(),0);assert.equal(await driver.page.getByRole('group',{name:/自检|测验/}).count(),0);
  await driver.page.getByLabel('学习记录 '+task.task_id,{exact:true}).fill(course.completion_requirement);
  await driver.page.getByLabel('学习反馈 '+task.task_id,{exact:true}).fill(course.content);
  await driver.page.getByRole('button',{name:'保存草稿与反馈',exact:true}).click();await driver.page.getByText('草稿与反馈已保存。',{exact:true}).waitFor();
  await driver.page.reload();await driver.page.getByRole('button',{name:'培训任务',exact:true}).click();await driver.page.getByRole('button',{name:'打开课程与记录'}).first().click();
  await driver.page.getByText(course.content,{exact:true}).waitFor();assert.equal(await driver.page.getByLabel('学习记录 '+task.task_id,{exact:true}).inputValue(),course.completion_requirement);
  driver.page.once('dialog',d=>d.accept());await driver.page.getByRole('button',{name:'提交学习记录',exact:true}).click();await driver.page.getByText('已提交，等待人工复核',{exact:false}).waitFor();
  console.log('PASS source course reading, saved feedback, reload and submission without quiz');
  const review=await admin.context.request.post(work.base+`/api/training-tasks/${task.task_id}/review`,{data:{decision:'approved',reason:course.completion_requirement}});assert.equal(review.status(),200);
  await driver.page.getByRole('button',{name:'查看学习复盘汇总',exact:true}).click();await driver.page.getByLabel('学习复盘汇总').waitFor();
  await driver.page.getByLabel('学习复盘汇总').getByText('人工复核意见：'+course.completion_requirement,{exact:true}).waitFor();
  await driver.page.getByText('复核通过',{exact:true}).waitFor();
  await driver.page.screenshot({path:join(output,'source-learning-report-mobile.png'),fullPage:true});
  console.log('PASS report displays actual stored course, feedback and staff review');
  await admin.page.goto(work.base+'/#/tr-ledger');await admin.page.getByRole('heading',{name:'培训任务台账',exact:true}).waitFor();
  await admin.page.screenshot({path:join(output,'source-admin-ledger.png'),fullPage:true});
  for(const route of ['overview','ev-fleet','rm-queue','rm-replay','sm-accounts']){
    await admin.page.goto(work.base+'/#/'+route);
    await admin.page.locator('main').waitFor();await admin.page.waitForTimeout(400);
  }
  console.log('PASS source-backed overview, fleet, risk queue, replay and local accounts routes');
  for(const page of [driver.page,admin.page])assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(failures,[]);
  await writeFile(join(output,'browser-result.json'),JSON.stringify({source_hash:work.store.sourceHash,business_source:'IE亮剑 only',groups:7,external_requests:external,page_errors:errors,http_failures:failures,notice:'Course approvals and workflow rows exist only in this isolated browser database; the clean candidate retains source draft states.'},null,2));
  console.log('PASS mobile/desktop layout, no page errors and no external requests');
}finally{await browser?.close();await work.stop();}
