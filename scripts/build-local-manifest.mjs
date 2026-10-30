import { writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { candidateFiles } from "./candidate-files.mjs";
import { openLocalStore } from "./local-data-store.mjs";
const root=fileURLToPath(new URL('../',import.meta.url));
const isolated=join(root,'.source-tests');await mkdir(isolated,{recursive:true});
const source=await openLocalStore({directory:await mkdtemp(join(isolated,'manifest-'))});
try{
  const {files,code_hash}=await candidateFiles();
  const manifest={candidate:'IE-Agent source-only local candidate',business_source:'IE亮剑/outputs/agent_starter/import only',source_hash:source.sourceHash,source_files:source.provenance,code_hash,files,node:process.version,state_basis:'Fresh isolated source import; existing .local state is never opened or changed',clean_state:{training_tasks:source.rows('training_tasks').length,course_statuses:source.rows('training_courses').map(x=>({course_id:x.course_id,status:x.content_status}))},limits:['No external model or data calls in local mode','No professional quiz or invented approvals','SQLite acceptance is not PostgreSQL/cloud deployment acceptance']};
  const out=join(root,'docs/driver/review/local-candidate-manifest.json');await mkdir(join(root,'docs/driver/review'),{recursive:true});await writeFile(out,JSON.stringify(manifest,null,2)+'\n');console.log(out);
}finally{source.close();}
