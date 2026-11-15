# dsh-settings

A DSH settings package that folds three settings pages into one settings-sidebar entry:

- **Preset preferences**: pick the default agent preset per workspace for new sessions.
- **Skills**: adjust how much of each skill the model sees, globally and per project.
- **Quick replies**: a button in the input toolbar that sends a preset phrase with one click; a settings page to edit the presets.

All three share one draft / revert / save page header; client plugins cannot share code across plugins, so the header is
shared inside this one package.

## Install

In the profile's `package.json`, point `dependencies` at this directory with `link:` and add `dsh-settings` to
`dsh.profile.bundles`. The plugin ships a patch layer that inserts a single `id: settings-prefs` entry; do not add a second
same-id insert in the profile yourself.

## Configuration

The only host config is one switch (write `- id: settings-prefs` with `config:` in the profile's `cordis.patch.yml`):

```yaml
- id: settings-prefs
  config:
    quickReply: false
```

With `quickReply: false` the toolbar button and the Quick replies settings page disappear; set it back to `true` and they
reappear immediately, no restart.

Everything else is edited in the UI:

- Preset preferences and quick replies live in the `presetPreferences` / `quickReplies` sections of `preferences.json`.
- Skill rules live in `~/.agents/skill-exposure.json`.

## Development

```bash
pnpm install
pnpm run check   # typecheck + build + test
```

See [AGENTS.md](AGENTS.md) for details.
