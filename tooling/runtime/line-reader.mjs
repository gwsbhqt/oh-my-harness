import { StringDecoder } from 'node:string_decoder'

// 三件事必须一起做对：多字节字符跨 chunk 用 StringDecoder 兜；半行留到下一批；
// 流结束时把没有换行的最后一行也交出去（很多命令最后一行不换行，丢了就是丢了）。
export class LineReader {
  #decoder = new StringDecoder('utf8')
  #carry = ''
  #onLine
  #onError

  constructor(onLine, onError) {
    this.#onLine = onLine
    this.#onError = onError
  }

  attach(stream) {
    if (stream === undefined) return
    stream.on('data', chunk => {
      this.#push(this.#decoder.write(chunk))
    })
    stream.on('end', () => {
      this.#push(this.#decoder.end())
      this.takeCarry()
    })
    stream.on('error', error => {
      this.#onError(error)
    })
  }

  takeCarry() {
    const carry = this.#carry
    this.#carry = ''
    if (carry.length > 0) this.#onLine(carry.replace(/\r$/, ''))
    return carry
  }

  #push(text) {
    this.#carry += text
    let index = this.#carry.indexOf('\n')
    while (index >= 0) {
      this.#onLine(this.#carry.slice(0, index).replace(/\r$/, ''))
      this.#carry = this.#carry.slice(index + 1)
      index = this.#carry.indexOf('\n')
    }
  }
}
