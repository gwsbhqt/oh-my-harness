[中文](README.md) | English

# dsh-image-cap

[← oh-my-harness](../README.en.md#components) · [Tutorial](../docs/dsh-image-cap.en.md)

**In short:** Limits the size and number of images sent to the model.

Apply a long-edge limit and an image-count budget to model requests in DeepSeek Harness (DSH). This complements the host's image area, byte, encoding, and cache policies. It does not process pixels itself or add a native image dependency.

## Requirements and installation

Requires a compatible DeepSeek Harness (DSH) installation with the attachment service and LLM adapter runtime, Node.js `^22.19.0 || >=24.0.0`, and pnpm. The package manifest records the tested host dependencies; the current tests use DSH 0.2.2-rc.1. Keep the shared `tooling/` directory alongside this plugin in the containing repository. This source directory is not a standalone build project.

From this plugin directory:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Merge a linked dependency and bundle into your DSH profile's package manifest:

```json
{
  "dependencies": {
    "dsh-image-cap": "link:../../path/to/oh-my-harness/dsh-image-cap"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-image-cap"]
    }
  }
}
```

Replace the example link with a path relative to your profile directory. Install the profile's dependencies using the pnpm version supported by DSH, validate the profile if a startup checker is available, and restart DSH. The bundle registers its entry; do not insert a duplicate entry.

## Behavior and relationship to DSH

For an image whose request target exceeds `maxLongEdge`, the plugin asks the host's `longEdgeDimensions()` function for a smaller target, then forwards it to the host attachment service. DSH still performs the resize and encoding. Existing smaller targets and byte budgets stay intact. A synthetic 4800-by-800 image with a 2000-pixel edge limit becomes a 2000-by-333 target.

For agent-loop requests, the plugin counts retained image blocks before adapter invocation. If the count exceeds the provider's configured budget, it marks the oldest images as offloaded and uses DSH's own projection to produce text placeholders with attachment information. The original session messages and attachments remain unchanged. Omitted images are absent from that model request; viewing them again requires the host's attachment-reading tools.

Offloading occurs in batches to avoid changing the history prefix for every new image. With an explicit count limit of 30 and quantum of 8, a synthetic request with 31 images omits the oldest 8 and keeps 23; 38 images omit the same 8, while 39 omit 16. A larger quantum can omit more images than strictly necessary, keeping the prefix stable longer. A quantum of 1 minimizes omitted images at the cost of more frequent prefix changes.

The adapter hook covers both `llm.stream()` and `preparedCall.stream()` for agent-loop requests. It does not limit network requests made independently by external tools, replace adapter byte limits, or modify non-agent requests' image count. Errors while resolving settings or projecting images pass the original request to the host with a warning. Host internal-method changes can disable a hook; contract tests check these integration points.

This is a configurable policy, not a universal provider limit or a guarantee that a provider accepts a request. Choose limits that fit your provider and quality needs. Lower long-edge limits reduce image detail; lower count limits remove older visual context from each request.

## Configuration

Override the existing entry in your profile patch, or use its settings card in the DSH Web UI:

```yaml
- id: image-cap
  config:
    maxLongEdge: 2000
    maxImagesPerRequest: 16
    imageCountQuantum: 8
    providerMaxImages: {}
```

All four fields are volatile and apply to subsequent calls without remounting. The bundle's count budget is deliberately lower than the schema default; existing defaults are not changed by this documentation.

| Setting | Schema default | Shipped bundle value | Meaning |
| --- | --- | --- | --- |
| `maxLongEdge` | `2000` | `2000` | Maximum target long edge in pixels, minimum 1. Applies through the attachment service. |
| `maxImagesPerRequest` | `30` | `16` | Global request image count budget, minimum 1. The lower bundle value reduces repeated image transfer. |
| `imageCountQuantum` | `8` | `8` | Offloading batch size, minimum 1. |
| `providerMaxImages` | `{}` | `{}` | Count budget by actual provider ID; each value is at least 1. Missing IDs use the global count budget. |

Profile overrides take precedence over the bundle. To disable the entire plugin, set `disabled: true` on `id: image-cap`. Code changes require rebuilding and restarting DSH.

## Development and verification

```sh
pnpm run typecheck
pnpm run build
pnpm run test
# All three:
pnpm run check
```

Image sizes, provider IDs, and attachment references in tests are synthetic. The tests call the host's real dimension and offloaded-image projection functions. Real Cordis services check wrapper ownership, prototype methods, hot reload, and unloading. A recording adapter attached to the real LLM runtime verifies both request entry points without calling an external model. These checks do not measure live provider limits, upload savings, or GUI rendering.

The source depends on host internal method shapes. Run the contract tests after upgrading DSH. Remove the plugin when host policies provide both equivalent limits.

## License

MIT. See [LICENSE](LICENSE).