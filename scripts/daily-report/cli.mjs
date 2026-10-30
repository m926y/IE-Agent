import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalStore } from '../local-data-store.mjs';
import { generateDailySafetyReport } from './report-service.mjs';

const args=process.argv.slice(2);
if (args.length!==4 || args[0]!=='--driver' || args[2]!=='--date') {
  console.error('Usage: node scripts/daily-report/cli.mjs --driver <source-driver-id> --date YYYY-MM-DD');
  process.exitCode=2;
} else {
  const root=fileURLToPath(new URL('../../.source-tests/',import.meta.url));
  await mkdir(root,{recursive:true});
  const directory=await mkdtemp(join(root,'daily-report-cli-'));
  let store;
  try {
    store=await openLocalStore({directory});
    console.log(JSON.stringify(generateDailySafetyReport(store,args[1],args[3]),null,2));
  } catch(error) {
    console.error(error?.message || String(error));
    process.exitCode=1;
  } finally {
    store?.close();
    await rm(directory,{recursive:true,force:true});
  }
}
