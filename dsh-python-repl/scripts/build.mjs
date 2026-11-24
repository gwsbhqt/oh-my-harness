import {cpSync, existsSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPlugin} from '../../tooling/build.mjs';

await buildPlugin(import.meta.url,{steps:[["tsdown"]]});

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sharedCore = join(pkgRoot, '..', 'python-repl-core', 'src', 'python_repl_core');
const bundledCore = join(pkgRoot, 'lib', 'python_repl_core');
if (existsSync(sharedCore)) {
  rmSync(bundledCore, {recursive: true, force: true});
  cpSync(sharedCore, bundledCore, {
    recursive: true,
    filter: (src) => !src.endsWith('__pycache__') && !src.endsWith('.pyc'),
  });
}
