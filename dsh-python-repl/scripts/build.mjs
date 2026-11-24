import {cpSync, existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {buildPlugin} from '../../tooling/build.mjs';

await buildPlugin(import.meta.url, {
  steps: [
    ['tsdown'],
    ({dir}) => {
      const sharedCore = join(dir, '..', 'python-repl-core', 'src', 'python_repl_core');
      const bundledCore = join(dir, 'lib', 'python_repl_core');
      if (existsSync(sharedCore)) {
        rmSync(bundledCore, {recursive: true, force: true});
        cpSync(sharedCore, bundledCore, {
          recursive: true,
          filter: (src) => !src.endsWith('__pycache__') && !src.endsWith('.pyc'),
        });
      }
    },
  ],
});
