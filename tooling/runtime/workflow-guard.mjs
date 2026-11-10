const marker = Symbol.for('dsh.workflow-disable.v1')
const workflow = new Set(['@deepseek-ai/dsh-workflow-ptc', '@deepseek-ai/dsh-tool-workflow'])

function isRow(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function updateWorkflowGuard(rows, owner, enabled) {
  let changed = false
  const out = rows.map(row => {
    if (!isRow(row)) return row
    if (row.group === true && Array.isArray(row.config)) {
      const children = updateWorkflowGuard(row.config, owner, enabled)
      if (children === undefined) return row
      changed = true
      return { ...row, config: children }
    }
    if (typeof row.name !== 'string' || !workflow.has(row.name)) return row
    const prior = row[marker]
    if (enabled) {
      if (prior === undefined && row.disabled === true) return row
      if (prior?.owners.includes(owner)) return row
      const state = prior ?? { owners: [], hadDisabled: Object.hasOwn(row, 'disabled'), disabled: row.disabled }
      changed = true
      return { ...row, disabled: true, [marker]: { ...state, owners: [...state.owners, owner] } }
    }
    if (prior === undefined || !prior.owners.includes(owner)) return row
    const owners = prior.owners.filter(value => value !== owner)
    changed = true
    if (owners.length > 0) return { ...row, [marker]: { ...prior, owners } }
    const restored = { ...row }
    delete restored[marker]
    if (restored.disabled === true) {
      if (prior.hadDisabled) restored.disabled = prior.disabled
      else delete restored.disabled
    }
    return restored
  })
  return changed ? out : undefined
}
