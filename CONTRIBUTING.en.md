[中文](CONTRIBUTING.md) | English

# Contributing

Start with a small problem, an observed result, and a proposed change. Discuss broad architecture, a new component, or a new dependency in an issue before investing in an implementation. This is an independent project with best-effort maintenance, not a support service with a response deadline.

Read the [overview](README.en.md), the relevant component README, and the [security policy](SECURITY.en.md). Follow the [Code of Conduct](CODE_OF_CONDUCT.en.md). Use private vulnerability reporting for security findings; do not attach real accounts or session data to public reports.

## Work in the component that owns the behavior

DSH supplies the host runtime. Plugins live in the root `dsh-*` directories and use adjacent `tooling/`. The browser, desktop, and SSH (Secure Shell for remote connections) tools live in `skills/` with shared transport code in `skills/_shared`. Usage documents live in `docs/`; deeper reasoning belongs in `docs/design/`. Avoid copying a second parameter table into several places.

Preserve upstream notices and provenance. Do not vendor another project's code without recording its source and license. Do not add a dependency on a component outside this repository or make a public component depend on an optional private integration.

Use fictional fixtures. No real names, account records, credential material, private addresses, machine identities, authenticated screenshots, or working-directory snapshots should enter a patch. An anonymized summary is usually more useful than an exported transcript. Preserve another contributor's work and staging choices.

## Implement and verify

Keep installation and component dependencies separate. Follow the component README's package-manager instructions rather than introducing a new workspace or installing everything in the repository root. A typical plugin check is:

```sh
pnpm --dir dsh-monitor install --frozen-lockfile
pnpm --dir dsh-monitor run check
```

Use the equivalent commands for the plugin you changed. Run Python skill checks in that skill's own documented environment. Desktop permissions, Swift integration, and other macOS behavior require the supported platform; do not claim a pure Linux test validates them. CI workflows may check portable parts without running a real desktop.

For a defect, reproduce the original input shape and cover the failure boundary. Meaningful tests exercise actual contracts, error propagation, cancellation, and ownership. Do not add assertions that merely restate a harmless text edit. Shared changes need the affected consumers checked. If you cannot perform a live check, state what was checked and what remains unverified.

Plugin code is not necessarily reloaded just because a settings file changes. Use the host's startup checks before applying changes; follow the component's documented restart path and authorization. Do not use someone else's running session or desktop as an automated test fixture.

For documented measurement changes, run:

```sh
python3 benchmarks/run.py --check benchmarks/results.json
```

A changed source hash requires review. Regenerate deliberately after establishing why the results changed; do not remove the check to make it pass. Quote the estimator, input, boundary, and exclusions whenever a result is used. No synthetic result establishes provider bills or general productivity gains.

## Submit a reviewable change

Explain the concrete problem, resulting behavior, and evidence. List commands actually run and their outcomes. Distinguish inspected test code, a test run, and a live end-to-end result. Include limitations and remaining external steps. For a visual change, provide real before/after evidence with private content removed; do not simulate a successful screen.

Use the [pull request template](.github/pull_request_template.md). Keep the change focused; do not mix an unrelated cleanup or another contributor's edits into it. Human contributors remain responsible for code generated with agents, its provenance, its tests, and any external action it takes.

## Community and release work

The [changelog](CHANGELOG.en.md) describes release scope. A heading for an upcoming release does not prove its tag exists. Workflow files, repository settings, media recordings, tags, and publishing each require their own evidence and task authorization. Do not infer permission to deploy or change visibility from permission to edit documentation.