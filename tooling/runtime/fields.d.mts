export interface StringListField {
  field: string
  format(value: unknown): string
  parse(text: string): { kind: 'clear' } | { kind: 'set'; value: string[] } | undefined
}
export declare function stringListField(field: string): StringListField
