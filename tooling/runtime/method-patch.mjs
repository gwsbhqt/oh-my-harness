// 宿主对象经 cordis 服务代理取到时，每读一次方法都返回新包装，所以原实现和「实例上现在装的是谁」
// 都按属性描述符读：拿包装当原实现会把上一层补丁一起包进来，拿包装比身份永远不相等，卸载时就删不掉。
// 实例上还挂着同一插件旧的一层时（乱序重载：新 apply 先于旧 dispose），新层接在旧层下面，不叠层；
// 卸载时实例上还是自己就换回装之前的属性，别人又包了一层就只把自己变成直通。
export function createMethodPatcher(owner) {
  // Symbol.for：热重载换了模块实例，新代码也要认得旧代码装的那层。
  const marker = Symbol.for(`${owner}.layer`)
  const layerOf = value => typeof value === 'function' ? Object.getOwnPropertyDescriptor(value, marker)?.value : undefined

  return (target, key, wrap) => {
    const own = Object.getOwnPropertyDescriptor(target, key)
    const earlier = layerOf(own?.value)
    const previous = earlier === undefined ? own : earlier.previous
    const original = previous?.value ?? inheritedMethod(target, key)
    if (typeof original !== 'function') return undefined

    const patched = wrap(original)
    let active = true
    const layer = function (...args) {
      return (active ? patched : original).apply(this, args)
    }
    Object.defineProperty(layer, marker, { value: { previous } })
    Object.defineProperty(target, key, { value: layer, writable: true, configurable: true, enumerable: false })

    return () => {
      active = false
      if (Object.getOwnPropertyDescriptor(target, key)?.value !== layer) return
      if (previous === undefined) delete target[key]
      else Object.defineProperty(target, key, previous)
    }
  }
}

function inheritedMethod(target, key) {
  for (let proto = Object.getPrototypeOf(target); proto !== null; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key)
    if (descriptor !== undefined) return descriptor.value
  }
  return undefined
}
