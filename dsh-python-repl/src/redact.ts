import { homedir } from 'node:os'

/**
 * Collapse the user's home directory to `~` in error output. An absolute path
 * under the home directory otherwise leaks the account name and adds length the
 * model does not need. Only applied to failed cells: a successful result keeps
 * real paths so the model can still act on them.
 */
export function redactHome(text: string): string {
  if (text === '') return text
  const home = homedir()
  if (home === undefined || home === '') return text
  let out = text.split(home).join('~')
  const win = home.replaceAll('/', '\\')
  if (win !== home) out = out.split(win).join('~')
  return out
}
