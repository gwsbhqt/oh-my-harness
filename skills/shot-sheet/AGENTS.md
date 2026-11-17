# Maintaining shot-sheet

Read the component README and both skill documents before changing an entry point. Keep `SKILL.md` and `PYSKILL.md` identical outside corresponding code examples. The five public functions are synchronous, and the CLI dispatches to the same functions through the sibling `skills/_shared/agentkit/cli.py`.

Preserve input order, timestamp selection, dimension limits, real error reporting, and output collision behavior. Document the difference between media overwrite protection and the image functions that replace their output. Do not infer visual correctness from a file existing or a process exiting successfully.

Use generated images, GIFs, and videos as test fixtures. Never check in user screenshots, recordings, fonts, installation state, caches, or local paths. Keep README content in Chinese and English. Preserve MIT notices when bundling the shared adapter.

Run the README test command in this component's environment. Video tests need FFmpeg, and Chinese layout checks need a CJK font. Validate wheel installation and a wheel rebuilt from the source archive without relying on personal skill paths. Open an actual fictional output for visual changes; explain which platforms and optional dependencies were tested.
