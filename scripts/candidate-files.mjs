import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const projectRoot = fileURLToPath(new URL('../',import.meta.url));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function candidateFiles() {
  const names=['server.mjs','package.json','package-lock.json','tsconfig.json','vite.config.ts','index.html'];
  for(const dir of ['src','server','scripts','tests','dist']) {
    for(const entry of await readdir(join(projectRoot,dir),{recursive:true,withFileTypes:true})) if(entry.isFile()) names.push(relative(projectRoot,join(entry.parentPath,entry.name)).replaceAll('\\','/'));
  }
  const files=await Promise.all(names.sort().map(async file=>({file,sha256:sha256(await readFile(join(projectRoot,file)))})));
  return {files,code_hash:sha256(JSON.stringify(files))};
}
