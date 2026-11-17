import { asarParts } from './asar.ts'

/**
 * Dependency and cache directories are omitted unless the call names one explicitly. Their generated
 * content can consume traversal time and raw-output budgets before useful project matches are returned.
 */
export const SKIPPED_DIRECTORIES = ['node_modules', '.venv', 'site-packages', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox'] as const

/** The extracted archive copy and `.asar.unpacked`: both are mostly node_modules and are only searched on purpose. */
const ARCHIVE_FILES = /(?:^|[\\/])(?:plugins[\\/]grep-scope[\\/]asar|[^\\/]+\.asar\.unpacked)(?:[\\/]|$)/

/**
 * Directory names to leave out for one call: none when the path points into an `.asar` archive or its
 * copy, or when the path, pattern or include already names one of them; else all of them.
 */
export function skippedDirectories(path: string | undefined, ...filters: Array<string | undefined>): string[] {
  if (path !== undefined && (asarParts(path, '/') !== undefined || ARCHIVE_FILES.test(path))) return []
  const named = [path, ...filters].some(text => text !== undefined &&
    text.split(/[\\/]/).some(part => (SKIPPED_DIRECTORIES as readonly string[]).some(name => part.includes(name))))
  return named ? [] : [...SKIPPED_DIRECTORIES]
}

/** ripgrep globs excluding `names`; they must come after any positive glob because the last matching glob wins. */
export function skipGlobs(names: readonly string[]): string[] {
  return names.flatMap(name => [`--glob=!**/${name}`, `--glob=!**/${name}/**`])
}

/** `argv` with the exclusions inserted before the `--` that starts the search roots, or appended when there is none. */
export function withSkipGlobs(argv: readonly string[], names: readonly string[]): string[] {
  if (names.length === 0) return [...argv]
  const roots = argv.indexOf('--')
  return roots < 0 ? [...argv, ...skipGlobs(names)] : [...argv.slice(0, roots), ...skipGlobs(names), ...argv.slice(roots)]
}

export function skipNote(names: readonly string[] | undefined): string {
  if (names === undefined || names.length === 0) return ''
  return `Skipped dependency and cache directories (${names.join(', ')}); to search one, put its name in path, pattern or include.`
}
