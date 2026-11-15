/**
 * 纯规则：判断一条会话标题是不是“没用的一次性/测试会话”。不碰宿主，方便单测。
 */
export const JUNK_TITLE =
  /慢查询|运行命令|运行模拟查询|模拟查询|验证后台|验证异步|验证 python 后台|后台运行命令|查询技能|查询 finish|查询已导入|查询 sync_up|统计目录|统计文件|统计项目|按扩展名|查找最大|查找目录|查找项目|查找体积|列出文档|提取文档|列出 markdown|提取 markdown|统计日志|统计各日志|统计 echo|执行命令并|用 bash 打印|打印标准输出|列出临时目录|运行命令并|大文件行数|读取大文件|读取文件并统计|读取 dsh 重启|读取 dsh-use|读取技能中|查询 dsh 重启|查询dsh-use|查询 dsh-use|查找重启 dsh|统计文件行数|统计文件数|列出文件大小|目录文件大小|统计大文件|读取重启 dsh|创建目录|列出目录/iu

export function isJunkTitle(title: string): boolean {
  const t = (title ?? '').trim()
  if (t === '') return true
  return JUNK_TITLE.test(t)
}
