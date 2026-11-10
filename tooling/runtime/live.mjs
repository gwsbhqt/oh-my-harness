export function live(value) {
  if (typeof value === 'object' && value !== null && typeof value.get === 'function') {
    return value.get()
  }
  return value
}
