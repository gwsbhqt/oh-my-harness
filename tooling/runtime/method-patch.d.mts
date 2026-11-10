/**
 * 就地换掉实例上的一个方法。
 *
 * @param target - 服务对象，服务代理即可（会被就地修改）
 * @param key - 方法名
 * @param wrap - 拿到原实现，返回补丁函数；原实现在装之前取好，装完再从实例上取会取到补丁自己
 * @returns 卸载函数；方法不存在时返回 undefined（没装）
 */
export type MethodPatch = <F extends (...args: never[]) => unknown>(
  target: object,
  key: string,
  wrap: (original: F) => F,
) => (() => void) | undefined

/** owner 决定层标记 `Symbol.for(`${owner}.layer`)`，各插件用自己的包名，互不认作旧层。 */
export declare function createMethodPatcher(owner: string): MethodPatch
