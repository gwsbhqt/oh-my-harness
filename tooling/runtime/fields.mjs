export function stringListField(field) {
  return {
    field,
    format: value => Array.isArray(value) ? value.join(', ') : '',
    parse: text => {
      const trimmed = text.trim()
      if (!trimmed) return { kind: 'clear' }
      const items = trimmed.split(',').map(item => item.trim()).filter(Boolean)
      if (items.length === 0) return undefined
      return { kind: 'set', value: items }
    },
  }
}
