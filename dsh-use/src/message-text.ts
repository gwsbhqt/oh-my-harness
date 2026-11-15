/**
 * 消息正文的转义还原。
 *
 * 调用方（尤其经 shell 拼 `dsh-use ... {json.dumps(msg)}` 的脚本）有时会先把中文
 * JSON 转义成 `\uXXXX` 再传进来；dsh-use 收到什么就原样存，于是会话里出现读不了的
 * 编号串。这里在入口做一次保守还原：只有正文里没有任何真实的东亚字符、却含有
 * `\uXXXX` 转义、且解出来确实是东亚文字时，才替换成解码结果；正常中文/英文原样返回，
 * 避免误伤本来就含反斜杠或转义字样的正文。
 */

const EAST_ASIAN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const UNICODE_ESCAPE = /\\u[0-9a-fA-F]{4}/

/** 把消息里的 `\uXXXX` 与常见单字符转义（\n \r \t \b \f \" \/ \\）还原成真实字符。 */
export function decodeMessageEscapes(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|[nrtbf"\/\\])/g, (whole: string, token: string) => {
    if (token.length === 5 && token[0] === 'u') {
      return String.fromCharCode(parseInt(token.slice(1), 16))
    }
    switch (token) {
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      case 'b': return '\b'
      case 'f': return '\f'
      default: return token // " / \\
    }
  })
}

/** 判断正文是否像是「被 JSON 转义过的东亚文字」。 */
export function looksEscapedMessage(text: string): boolean {
  if (!UNICODE_ESCAPE.test(text)) return false
  if (EAST_ASIAN.test(text)) return false // 已经有真实东亚字符，视为正常正文
  return EAST_ASIAN.test(decodeMessageEscapes(text))
}

/** 入口处的正文规整：疑似被转义过的东亚文字就还原，否则原样返回。 */
export function normalizeMessageText(text: string): string {
  if (!looksEscapedMessage(text)) return text
  return decodeMessageEscapes(text)
}
