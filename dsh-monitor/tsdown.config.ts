import { defineConfig } from "tsdown"
import { hostConfig, clientConfig, packageId } from "../tooling/tsdown.mjs"

const ID = packageId(import.meta.url)

export default defineConfig([
  hostConfig({ "name": "host", "target": "es2022", "sourcemap": false, "define": { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") }, "clean": undefined, "dependencyMode": "legacy" }),
  clientConfig({ "id": ID, "modules": "web", "dependencyMode": "legacy", "purity": { "message": "不在平台模块表——跨插件值导入禁止；协作走 cordis 服务（类型导入会被擦除，到不了这里）" }, "define": { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") } })
])
