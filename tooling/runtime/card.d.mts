export interface CardForm<Shell extends object, Field, Actions extends object> {
  shell(): Shell
  field(name: string): Field
  actions(): Actions
  dispose(): void
}
export declare function createCardController<Shell extends object, Field, Actions extends object, Hook extends string, Store>(
  form: CardForm<Shell, Field, Actions>,
  specs: readonly { field: string }[],
  hookName: Hook,
  bind: (projection: () => Shell & Record<string, Field>) => Store,
): {
  form: CardForm<Shell, Field, Actions>
  store: Store
  projection(): Shell & Record<string, Field>
  inject(): { hooks: Record<Hook, Store> } & Actions
  dispose(): void
}
