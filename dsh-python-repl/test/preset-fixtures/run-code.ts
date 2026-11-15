import type { Context } from '@deepseek-ai/cordis'

// Stands in for the PTC preset's run_code consumer: records which runtime a top-level preset row sees.
export const inject = ['ptcRuntime']
export const seen: string[] = []
export function apply(ctx: Context): void {
  seen.push((ctx.get('ptcRuntime') as { language: string }).language)
}
