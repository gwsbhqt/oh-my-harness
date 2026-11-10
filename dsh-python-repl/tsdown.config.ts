import { defineConfig } from "tsdown"
import { hostConfig, clientConfig, packageId } from "../tooling/tsdown.mjs"

const ID = packageId(import.meta.url)

export default defineConfig([
  hostConfig({ "name": "host", "target": "es2022", "sourcemap": false, "define": { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") } }),
  clientConfig({ "id": ID, "modules": "web", "dependencyMode": "legacy", "sourcemap": false, "purity": { "message": "不在平台模块表——跨插件值导入禁止" }, "define": { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") } })
])
