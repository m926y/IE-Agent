import { startLocalWorkbench } from '../local-workbench.mjs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const { chromium }=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../../.source-tests/',import.meta.url));await mkdir(root,{recursive:true});
const directory=await mkdtemp(join(root,'daily-report-browser-'));
const work=await startLocalWorkbench({directory,pauseOutbox:true});
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  const admin=await browser.newContext(),driver=await browser.newContext({viewport:{width:390,height:900}}),other=await browser.newContext();
  async function login(context,name){const account=work.store.accounts.find(row=>row.username===name);const result=await context.request.post(work.base+'/api/auth/login',{data:account});assert.equal(result.status(),200);}
  await login(admin,'local_admin');await login(driver,'local_driver');await login(other,'local_other');
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const driverId=work.store.get('app_users','local_driver').driver_id;
  const priorDate=new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  assert.equal((await admin.request.post(work.base+'/api/admin/daily-reports/run',{data:{driver_id:driverId,report_date:priorDate}})).status(),200);
  const adminPage=await admin.newPage();await adminPage.goto(work.base+'/#/daily-reports');
  await adminPage.getByLabel('来源司机 ID').fill(driverId);
  await adminPage.getByRole('button',{name:'生成并发布',exact:true}).click();
  await adminPage.getByText('已发布 · 通知 1 条',{exact:false}).waitFor();
  const report=await (await driver.request.get(work.base+'/api/driver/reports/today')).json();
  await adminPage.screenshot({path:join(directory,'daily-report-admin.png'),fullPage:true});
  assert.equal((await other.request.get(work.base+`/api/driver/reports/${report.id}`)).status(),404);
  const page=await driver.newPage(),errors=[],external=[];
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('request',request=>{if(/^https?:/.test(request.url())&&new URL(request.url()).hostname!=='127.0.0.1')external.push(request.url());});
  await page.goto(work.base);
  await page.getByRole('button',{name:/安全简报/}).click();
  await page.getByRole('heading',{name:report.report.title,exact:true}).waitFor();
  await page.getByRole('heading',{name:'上一期目标跟踪',exact:true}).waitFor();
  await page.getByText('未读简报通知',{exact:true}).waitFor();
  await page.locator('.task-card').filter({hasText:`${date} 的历史安全简报`}).getByRole('button',{name:'标记已读并查看简报',exact:true}).click();
  await page.getByRole('heading',{name:'评分趋势',exact:true}).waitFor();
  if(report.report.risks.length){await page.getByText('为什么推荐这项核对',{exact:true}).click();const id=report.report.risks[0].evidenceRefs[0].slice(6);await page.getByRole('button',{name:`核对回放证据 ${id}`,exact:true}).click();await page.getByLabel('本人证据详情').getByText(id,{exact:true}).waitFor();}
  const goal=work.store.db.prepare('SELECT id FROM driver_safety_goals WHERE report_id=?').get(report.id);
  if(goal){await page.getByRole('button',{name:'计划核对',exact:true}).click();await page.getByText('反馈已保存；不代表安全行为已改善。',{exact:true}).waitFor();}
  await page.screenshot({path:join(directory,'daily-report-detail-mobile.png'),fullPage:true});
  await page.getByRole('button',{name:'历史简报',exact:true}).click();
  await page.getByText(`${date} · 版本 1`,{exact:true}).waitFor();
  await page.screenshot({path:join(directory,'daily-report-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log(`PASS daily report browser flow: ${directory}`);
}finally{await browser?.close();await work.stop();}
