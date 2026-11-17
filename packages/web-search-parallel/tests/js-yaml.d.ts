declare module 'js-yaml' {
  export function load(input: string, options?: { schema?: unknown }): unknown
  const yaml: { load: typeof load }
  export default yaml
}
