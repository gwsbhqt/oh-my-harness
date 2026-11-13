/** Text added to a failed cell or the next cell, telling the model what went wrong and the fix. */

/** Enough names to recognise the work; hundreds of failures need a count, not a list. */
const FAILED_TASKS_SHOWN = 10

/**
 * Tasks keep running after their cell, as in Prime, so one that fails does it
 * unseen; asyncio's own warning only appears when the task is collected.
 */
export function failedTasksNotice(tasks: readonly string[]): string {
  const shown = tasks.slice(0, FAILED_TASKS_SHOWN).join('; ')
  const more = tasks.length > FAILED_TASKS_SHOWN ? `; and ${tasks.length - FAILED_TASKS_SHOWN} more` : ''
  return `[dsh-python-repl] ${tasks.length} asyncio task(s) failed and nobody awaited them: `
    + `${shown}${more}. Keep a reference to the task and call its .exception() `
    + '(or await it) for the full traceback.'
}

/**
 * A cell that is really JavaScript/TypeScript fails as a bare Python
 * SyntaxError, which does not say what went wrong. The host labels every
 * run_code block "typescript" (dsh-client-ui-tool hard-codes it), so a model
 * reading its own transcript can be nudged into TS; name the language here.
 */
const JS_MARKERS = [
  /^\s*(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=/m,
  /\bconsole\.log\s*\(/,
  /=>\s*[{(]?/,
  /^\s*(?:async\s+)?function\s+[\w$]+\s*\(/m,
  /^\s*(?:import\s+[\w${},*\s]+\s+from\s+['"]|export\s+(?:const|function|default)\b)/m,
  /\bawait\s+tools\.[\w$]+\([^)]*\)\s*;\s*$/m,
]

export function foreignLanguageHint(code: string, evalue = ''): string {
  // Judge the line Python rejected, not the whole cell: a Python cell that
  // edits a .ts file carries TS in its strings, and its SyntaxError is a
  // Python quoting slip — calling it "JavaScript" would send the model the
  // wrong way.
  const at = /\bline (\d+)/.exec(evalue)
  const line = at === null ? undefined : code.split('\n')[Number(at[1]) - 1]
  const hits = line === undefined
    ? JS_MARKERS.filter((re) => re.test(code)).length >= 2
    : JS_MARKERS.some((re) => re.test(line))
  if (!hits) return ''
  return '\n\nThis cell looks like JavaScript/TypeScript. run_code executes PYTHON in a persistent kernel: '
    + 'write it as Python (x = await bash({...}), dicts for arguments, print()/a trailing expression to show results).'
}

/**
 * Import names whose package is named differently. Only mismatches: for every
 * other name the import name is the best guess, and the installer says so if not.
 */
const PACKAGE_FOR_IMPORT: Readonly<Record<string, string>> = {
  fitz: 'pymupdf',
  docx: 'python-docx',
  pptx: 'python-pptx',
  yaml: 'pyyaml',
  PIL: 'pillow',
  cv2: 'opencv-python',
  sklearn: 'scikit-learn',
  bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil',
  dotenv: 'python-dotenv',
  magic: 'python-magic',
  Quartz: 'pyobjc-framework-Quartz',
  AppKit: 'pyobjc-framework-Cocoa',
  Foundation: 'pyobjc-framework-Cocoa',
  Crypto: 'pycryptodome',
  jwt: 'pyjwt',
  serial: 'pyserial',
  win32api: 'pywin32',
}

/**
 * A cell that failed on a missing module gets the one-line fix for a library
 * the analysis needs, and the pointer to the project's environment for a
 * project's own code (Prime's usage rule).
 */
export function missingModuleHint(ename: string, evalue: string): string {
  if (ename !== 'ModuleNotFoundError') return ''
  const name = /No module named '([^']+)'/.exec(evalue)?.[1]?.split('.')[0]
  if (name === undefined || name.length === 0) return ''
  // `import skills.demo` (25 cells on real sessions, 2026-11-03): these are bound namespaces, not packages to install.
  if (name === 'skills' || name === 'tools') {
    return `\n\n\`${name}\` is already bound in every cell and is not a package: use \`${name}.<name>\` directly with no import `
      + `(e.g. ${name === 'skills' ? 'skills.demo.open_page(...)' : 'await tools.read_image({...})'}); await ${name}.list() shows what is there.`
  }
  const pkg = PACKAGE_FOR_IMPORT[name] ?? name
  return `\n\n\`${name}\` is not installed in this kernel. If it is a library for your own analysis, install it here `
    + `and import it in the same cell: await repl.install(${JSON.stringify(pkg)})`
    + `${pkg === name ? ' (if that is not the package name, use the one that provides it)' : ''}. `
    + "If it is a project's own package or dependency, run that code in the project's environment through bash "
    + "(`uv run …`, its `.venv`) instead of installing it into this kernel."
}

/**
 * Assigning to `repl` hides the API. The subprocess note moved to
 * python/detours.py, which reads the syntax tree instead of the
 * text and so ignores code that only appears inside strings.
 */
export function usageHint(code: string): string {
  if (/^\s*repl\s*=/m.test(code) || /^\s*for\s+repl\s+in\b/m.test(code)) {
    return '`repl` is a reserved system binding; assigning to it replaces the API you need. Use another name.'
  }
  return ''
}
