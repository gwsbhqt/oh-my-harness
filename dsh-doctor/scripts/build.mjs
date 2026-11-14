import fs from 'node:fs/promises';
import path from 'node:path';
import {buildPlugin} from '../../tooling/build.mjs';

await buildPlugin(import.meta.url,{steps:[async({dir})=>{
  await fs.mkdir(path.join(dir,'lib'),{recursive:true});
  await fs.copyFile(path.join(dir,'src/index.js'),path.join(dir,'lib/index.js'));
}]});
