export function createCardController(form, specs, hookName, bind) {
  const projection = () => {
    const fields = Object.fromEntries(specs.map(spec => [spec.field, form.field(spec.field)]))
    return { ...form.shell(), ...fields }
  }
  const store = bind(projection)
  return {
    form,
    store,
    projection,
    inject: () => ({ hooks: { [hookName]: store }, ...form.actions() }),
    dispose: () => form.dispose(),
  }
}
