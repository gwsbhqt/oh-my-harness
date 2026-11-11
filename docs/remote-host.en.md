[中文](remote-host.md) | English

# Using remote-host

Use remote-host when work must happen on an explicitly selected SSH (Secure Shell for remote connections) destination: inspect a system, execute a script, transfer a directory, or manage a longer-running job. Its command line and asynchronous Python interface share the system SSH transport. It is useful when the important evidence is the destination’s command result or transferred content.

## Select and check the destination

The supported calling platform is macOS with Python 3.10 or newer and system SSH tools. Authentication, ports, jumps, and related connection settings come from your SSH configuration. The tool does not provide a built-in inventory of destinations.

```sh
remote-host hosts
```

Host listing uses its native output; it has no JSON mode. Choose a configured alias deliberately. In this fictional example, `example-target` stands for an alias you have configured:

```python
result = await skills.remote_host.run(
    "uname -a", host="example-target", quiet=True
)
```

Inspect `result.code`, `result.out`, and `result.err`. A zero exit code establishes success for that command, not every later operation on the destination. Host pins can retain a default destination, interpreter, and working directory, but each tool keeps its own machine selection. Selecting a destination here does not select it for browser-control or computer-control.

## Choose the right execution shape

Use a regular run for a bounded command. Payloads are sent through standard input rather than being expanded by a local shell. Select the interpreter and working directory explicitly when a task depends on them, using the documented interface.

For longer work, use the job interface to start, list, follow, wait for, or stop a named remote job. Keep its identity and collect its final exit status and output. A start acknowledgement only means the job was started; it is not a completion report. Persistent sessions are available for workflows that intentionally retain shell state between calls.

For a fictional directory handoff, copy into the intended destination and verify the resulting tree. The copy interface verifies by default. Full verification and manifests can compare content and record directories and links; quick verification compares sizes and provides weaker evidence. Confirm that the resulting files can serve the intended task, not just that transport returned successfully.

## Handle uncertainty and limits

If a mutation times out or the connection drops, the remote outcome may be unknown. Check the destination or the recorded job before retrying. The Python result exposes this distinction through `remote_unknown` and `outcome`; stopping a local connection does not prove that remote work stopped.

Unix destinations need the interpreters and utilities required by the selected operation. Windows SSH support is limited to explicit PowerShell payload execution and does not provide Windows desktop or browser control. Native application and browser features additionally require their tools on the destination. Missing commands fail without local fallback or automatic installation.

Payloads run with the authenticated account’s real permissions. Trusted Python is also outside a sandbox; Harness tool approvals govern tool calls, not arbitrary Python host access. Inspect resolved paths before changes and account for symlinks when verifying results.

See the [tool README](../skills/remote-host/README.en.md) for complete command references, transfer behavior, host configuration, and proxy options. See the [Python runtime README](../dsh-python-repl/README.en.md) for skill discovery and trust settings, and the [Python data locality design](design/python-data-locality.en.md) for background. These instructions have not been presented as live SSH acceptance evidence.