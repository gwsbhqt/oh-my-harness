import type { Readable } from 'node:stream'

/** 按行切一条流；每个实例自带解码器和半行残留，换进程要重建。 */
export declare class LineReader {
  constructor(onLine: (line: string) => void, onError: (error: unknown) => void)
  /** 接上一条流；`undefined` 表示这条流没开，直接不管。 */
  attach(stream: Readable | undefined): void
  /** 取走还没凑成整行的残留并当作一行交出（收尾时用）。 */
  takeCarry(): string
}
