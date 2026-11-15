import { defineConfig } from "tsdown"
import { hostConfig, clientConfig, packageId } from "../tooling/tsdown.mjs"

const ID = packageId(import.meta.url)

export default defineConfig([
  hostConfig({ "name": "host", "entry": { "index": "src/index.ts" } }),
  clientConfig({ "id": ID, "modules": "minimal", "entry": { "client": "src/client/index.ts" }, "purity": { "message": "不在平台模块表——跨插件值导入禁止；协作走 cordis 服务" } })
])
