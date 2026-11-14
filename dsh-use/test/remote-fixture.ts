import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function remoteFixture(root: string, dispatch?: string): string {
  const shared = join(root, 'shared')
  const pkg = join(shared, 'agentkit/remote')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(shared, 'agentkit/__init__.py'), '')
  writeFileSync(join(pkg, '__init__.py'), '')
  writeFileSync(join(pkg, 'receiver.py'), `import json, sys
print(json.dumps({"tool": sys.argv[1], "host": sys.argv[2], "forwarded": sys.argv[3:]}))
`)
  writeFileSync(join(pkg, 'target.py'), dispatch ?? `import subprocess, sys
from pathlib import Path

def dispatch(tool, argv):
    args = list(argv)
    if args[:1] == ["--local"]:
        return args[1:], None
    if args[:1] in (["-H"], ["--host"]):
        done = subprocess.run([sys.executable, str(Path(__file__).with_name("receiver.py")), tool, *args[1:]])
        return [], done.returncode
    return args, None
`)
  return shared
}
