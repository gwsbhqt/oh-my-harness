// Tests boot the real runtime, which keeps per-session state under DSH_HOME.
// Pointing it at a throwaway directory keeps test runs from writing into the
// user's real ~/.dsh and from restoring each other's saved state.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.DSH_PYTHON_REPL_TEST_HOME) {
  process.env.DSH_PYTHON_REPL_TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-python-repl-home-'))
  process.env.DSH_HOME = process.env.DSH_PYTHON_REPL_TEST_HOME
}
