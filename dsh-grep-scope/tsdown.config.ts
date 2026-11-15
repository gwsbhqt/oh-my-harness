import { defineConfig } from "tsdown"
import { hostConfig } from "../tooling/tsdown.mjs"

export default defineConfig(hostConfig({ "target": "es2022", "sourcemap": false, "clean": undefined, "dependencyMode": "legacy" }))
