import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root=fileURLToPath(new URL('../',import.meta.url));
test('consolidated current documentation resolves its links and preserves cleanup provenance',async()=>{
  for(const file of ['README.md','AGENTS.md','docs/driver/README.md','docs/开发与验收指南.md','docs/第十轮验收与评审.md','docs/历史指导与评估归档.md']) {
    const text=await readFile(resolve(root,file),'utf8');
    for(const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const url=match[1];if(/^(?:[a-z]+:|#)/i.test(url))continue;
      const [path,fragment]=url.split('#'),target=resolve(dirname(resolve(root,file)),path);await access(target);
      if(fragment?.startsWith('archive-'))assert.ok((await readFile(target,'utf8')).includes(`id="${fragment}"`));
    }
  }
  const archive=JSON.parse(await readFile(resolve(root,'docs/归档与清理清单.json'),'utf8'));
  assert.equal(archive.merged_documents.length,8);assert.equal(archive.removed_legacy_files.length,35);
  for(const entry of archive.removed_legacy_files){assert.match(entry.sha256,/^[a-f0-9]{64}$/);assert.match(entry.git_blob_sha256,/^[a-f0-9]{64}$/);await assert.rejects(access(resolve(root,entry.path)),{code:'ENOENT'});}
});
