import { defineConfig } from "tsdown"
import { hostConfig, clientConfig, packageId } from "../tooling/tsdown.mjs"

const ID = packageId(import.meta.url)

export default defineConfig([
  hostConfig({ "sourcemap": false }),
  hostConfig({ "entry": { "dsh-use": "src/cli/dsh-use.ts" }, "sourcemap": false, "clean": false, "deps": undefined }),
  hostConfig({ "entry": { "dsh-use-mcp": "src/cli/mcp.ts" }, "sourcemap": false, "clean": false, "deps": { "neverBundle": [/^@deepseek-ai\//, /^@modelcontextprotocol\//, /^zod$/] } }),
  clientConfig({ "id": ID, "modules": "minimal", "entry": { "client": "src/client/index.tsx" }, "clean": false, "purity": { "message": "不在平台模块表——跨插件值导入禁止；协作走 cordis 服务" } })
])
