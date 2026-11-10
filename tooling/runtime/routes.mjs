// 新代先卸旧代；旧作用域随后卸载时不能删掉新代的同路径路由。
export function createRouteRegistry() {
  let generation = 0
  const disposers = []
  return (effect, register, routes, label) => {
    const current = ++generation
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 旧代可能已随作用域卸载。 */ }
    }
    for (const route of routes()) {
      let disposeReal
      effect(() => {
        disposeReal = register(route)
        return () => {
          if (current === generation) disposeReal?.()
        }
      }, label(route))
      disposers.push(() => disposeReal?.())
    }
  }
}
