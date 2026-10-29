import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, join } from "node:path";
import { createHash } from "node:crypto";
import { openLocalStore } from "./local-data-store.mjs";
const root=fileURLToPath(new URL('../',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const source=await openLocalStore();
try{
  const names=['server.mjs','package.json','package-lock.json','tsconfig.json','index.html','scripts/local-data-store.mjs','scripts/local-workbench.mjs','scripts/local-broker.mjs','scripts/source-ui-battery.mjs','scripts/prepare-publish.mjs','scripts/build-local-manifest.mjs','tests/local-source.test.mjs','tests/runtime.test.mjs'];
  for(const dir of ['src','dist'])for(const entry of await readdir(join(root,dir),{recursive:true,withFileTypes:true}))if(entry.isFile())names.push(relative(root,join(entry.parentPath,entry.name)).replaceAll('\\','/'));
  const files=[];for(const file of names.sort())files.push({file,sha256:hash(await readFile(join(root,file)))});
  const manifest={candidate:'IE-Agent source-only local candidate',business_source:'IE亮剑/outputs/agent_starter/import only',source_hash:source.sourceHash,source_files:source.provenance,code_hash:hash(JSON.stringify(files)),files,node:process.version,clean_state:{training_tasks:source.rows('training_tasks').length,course_statuses:source.rows('training_courses').map(x=>({course_id:x.course_id,status:x.content_status}))},limits:['No external model or data calls in local mode','No professional quiz or invented approvals','SQLite acceptance is not PostgreSQL/cloud deployment acceptance']};
  const out=join(root,'docs/driver/review/local-candidate-manifest.json');await mkdir(join(root,'docs/driver/review'),{recursive:true});await writeFile(out,JSON.stringify(manifest,null,2)+'\n');console.log(out);
}finally{source.close();}
