# 后台鼠标事件出处

完整上游 MIT 文本、署名与固定来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，分发时一并保留。

`bin/computer-use.swift` 里「精确定向投递（鼠标）」一节（`SkyMouse`、`skyLeftClick`、`skyScroll`、`withSyntheticFocus`）的做法照
[iFurySt/open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use)（MIT，Copyright (c) 2026 Leo，版本 `93b817501e0b9fa04fba155face2630bfcd0322e`，2026-09-29）的
`packages/OpenComputerUseKit/Sources/OpenComputerUseKit/SkyLightSPI.swift` 和 `SkyClickSimulation.swift` 改写：
用到的私有函数、事件字段编号（0/1/3/7/40/51/58/91/92）、「让目标以为自己在前台」的 0xF8 字节事件记录格式、Chromium 要的 (-1,-1) 预热点击，
都来自那里；该项目注明这些做法源自 MIT 许可的 Cua Driver 与 yabai。

改动：只保留左键单击/双击和滚轮两条路径，右键改用元素的 `AXShowMenu` 动作（实测后台右键鼠标事件在文本编辑里弹不出菜单）；
私有鼠标通道不可用时点击和拖拽直接报错，不自动转全局鼠标；右键只接受可靠的 AXShowMenu。显式全局鼠标路径会核对实际命中的应用和事件权限。
