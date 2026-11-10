/**
 * dsh-control：控制正在运行的 DSH。只做三件事：把命令送进本机通信口、打印结果、按结果给退出码。
 * 参数解释都在插件里；命令行只带一份命令表副本，DSH 没运行时 `dsh-control help` 也能列全。
 *
 * 另外几件必须在 DSH 外面做的事也在这里：wait / chat 的分段等待、start / doctor / restart / version。
 *
 * 退出码（没做成用户要的事一律非 0）：
 *   0   成功，或最后一轮成功完成
 *   1   任务失败或中止；其他错误，包括 DSH 执行了但报告失败（例如装插件失败）、拿不到额度报告
 *   2   用法错误、找不到会话、对上多个、被规则拦下（只读、禁用、拒绝换模型、整档没有可用模型、回答没被接收）
 *   10  会话停下来在等你回答（wait、chat、status）
 *   11  wait / chat：会话空闲，起点之后没有新内容，不会再有结果
 *   69  DSH 没在运行（或插件没加载）
 *   124 等待超时，会话还在跑或还有排队消息
 *
 * @module
 */
import { createCli } from './core.ts'

createCli()(process.argv.slice(2)).then((code) => { process.exitCode = code }, (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
