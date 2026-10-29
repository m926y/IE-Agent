import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { openLocalStore } from "./local-data-store.mjs";

import { createLocalBroker } from "./local-broker.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function startLocalWorkbench(options = {}) {
  const store = await openLocalStore(options), key = randomBytes(32).toString("hex");
  const faults = { notifications: false };
  const broker = createLocalBroker(store, key, faults);
  broker.listen(0, "127.0.0.1"); await once(broker,"listening");
  const probe=createServer(); probe.listen(options.port || 0,"127.0.0.1"); await once(probe,"listening"); const port=probe.address().port; await new Promise(r=>probe.close(r));
  const env={...process.env,HOST:"127.0.0.1",PORT:String(port),SSO_PROTECTED:"0",IE_LOCAL_SOURCE_ONLY:"1",IE_DATA_MANIFEST:`仅IE亮剑本地材料 · ${store.provenance.find(x=>x.table==='drivers').rows}个来源司机 · 历史回放 · 无实时接入`,SUPABASE_URL:`http://127.0.0.1:${broker.address().port}`,SUPABASE_ANON_KEY:key,SUPABASE_INSTANCE_ID:"ie-local-sqlite"};
  for(const name of Object.keys(env)) if(name.startsWith("QW_AI_")||name.startsWith("QWEN_")||name==='QW_EGRESS_PROBE_URL') delete env[name];
  const app=spawn(process.execPath,["server.mjs"],{cwd:root,env,stdio:["ignore","pipe","pipe"]});
  let logs=""; app.stdout.on("data",c=>{logs+=c;});app.stderr.on("data",c=>{logs+=c;});
  let worker;
  if(!options.pauseOutbox) worker=setInterval(()=>{try{store.drainOutbox();}catch{ /* remains durable pending; retry next tick */ }},1000);
  const base=`http://127.0.0.1:${port}`;
  async function stop(){clearInterval(worker);if(app.exitCode===null){app.kill();await once(app,"close");}await new Promise(r=>broker.close(r));store.close();}
  for(let i=0;i<200;i++){try{if((await fetch(base+"/healthz")).ok)break;}catch{}if(i===199){await stop();throw new Error("Local app did not start: "+logs.slice(-500));}await new Promise(r=>setTimeout(r,25));}
  return {base,store,faults,stop,logs:()=>logs};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const local=await startLocalWorkbench({port:Number(process.env.LOCAL_PORT||3100),directory:process.env.LOCAL_STATE_DIR});
  console.log(`Local workbench: ${local.base}\nData source: IE亮剑 only\nAccount file: ${local.store.directory}/accounts.json\nDatabase: ${local.store.directory}/workbench.sqlite`);
  for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>local.stop().then(()=>process.exit(0)));
}
