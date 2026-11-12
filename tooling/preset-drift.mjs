/**
 * 比较官方 PTC 模式与创造模式，检查派生模式会遗漏的官方改动。
 *
 * 继承的是创造模式，所以官方改创造模式会自动跟上；跟不上的只有 PTC 模式那一侧：
 * PTC 模式新增、创造模式没有的条目，以及两边都有但写得不一样的条目（已知的差别除外）。
 * 另外微调要从 PTC 模式现取工具呈现条目，取不到就改不成。
 *
 * 纯函数；`!!js` 节点由调用方解析成 `{__js: 源码}`。
 */

/** Support both official tool presentation layouts. */
const PRESENTATION = new Set(['@deepseek-ai/dsh-tool-executor-ptc', '@deepseek-ai/dsh-agent-tool-presentation']);
/** 两边本来就不一样、PTC 创造模式有意跟创造模式（或由微调处理）的条目。0.2.2-rc.2 起创造模式有自己的 persona，tool-office 由微调从 PTC 模式照搬。 */
const KNOWN = new Set(['persona', 'skill-filesystem', 'tool-presentation', 'tool-executor-ptc', 'tool-office', 'delegation/workflow-ptc', 'delegation/tool-workflow', 'tool-plugin-manager', 'tool-plugin-market']);

export function loadedPresetComparisons(bundles, skipped=[]) {
  const excluded=new Set(skipped.map(bundle=>bundle.name??bundle.packageName));
  return bundles.filter(bundle=>bundle.dir&&!bundle.error&&!excluded.has(bundle.name)).flatMap(bundle=>{
    if(bundle.presetDrift===undefined||bundle.presetDrift===false)return [];
    if(bundle.presetDrift!==true)throw new Error('dsh.presetDrift must be boolean: '+bundle.name);
    return [bundle];
  });
}

function rowsOf(list) {
  const out = new Map();
  const walk = (rows, prefix) => {
    for (const row of rows ?? []) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue;
      const key = prefix + row.id;
      if (row.group && Array.isArray(row.config)) {
        const {config: _children, ...rest} = row;
        out.set(key, rest);
        walk(row.config, key + '/');
      } else out.set(key, row);
    }
  };
  walk(list, '');
  return out;
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

/** 官方 preset 补丁（`- insert: [ {id: preset-x, config: {plugins}} ]`）里的条目。 */
export function officialPlugins(doc, id) {
  for (const item of Array.isArray(doc) ? doc : []) for (const row of item?.insert ?? []) if (row?.id === id) return row.config?.plugins;
  return undefined;
}

/** @returns 跟不上的地方；空数组表示 PTC 模式那一侧没有创造模式缺的东西 */
export function presetDrift(ptcPlugins, cordisPlugins) {
  if (!Array.isArray(ptcPlugins)) return ['读不到 DSH 自带 PTC 模式的条目'];
  if (!Array.isArray(cordisPlugins)) return ['读不到 DSH 自带创造模式的条目'];
  const ptc = rowsOf(ptcPlugins), cordis = rowsOf(cordisPlugins);
  const problems = [];
  if (![...ptc.values()].some(row => PRESENTATION.has(row.name))) problems.push('PTC 模式里找不到工具呈现条目，创造模式改不成 PTC 创造模式');
  for (const [key, row] of ptc) {
    if (KNOWN.has(key)) continue;
    if (!cordis.has(key)) problems.push(`PTC 模式新增了 ${key}，创造模式没有，PTC 创造模式不会带上`);
    else if (stable(row) !== stable(cordis.get(key))) problems.push(`${key} 在 PTC 模式和创造模式里写得不一样，PTC 创造模式用的是创造模式那份`);
  }
  return problems;
}
