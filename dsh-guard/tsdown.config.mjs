import { hostConfig } from '../tooling/tsdown.mjs';

// 两个 loader 条目要指向不同导出：默认入口是输出防护插件，额外入口是目标防护插件。
export default hostConfig({
  entry: { index: 'src/index.ts', 'goal-guard': 'src/goal-guard.ts' },
});
