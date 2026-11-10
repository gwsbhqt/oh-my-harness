// 插件启动时会去 DSH_HOME 下取走重启前暂停的监听记录（读完就删）。测试指到一次性目录，
// 免得跑一次测试就把真实 ~/.dsh 里等着接回的记录吃掉。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.DSH_MONITOR_TEST_HOME) {
  process.env.DSH_MONITOR_TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-monitor-home-'))
  process.env.DSH_HOME = process.env.DSH_MONITOR_TEST_HOME
}
