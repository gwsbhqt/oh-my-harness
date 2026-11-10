export interface BuildOptions {
  name?: string;
  entry?: Record<string, string>;
  outDir?: string;
  format?: 'esm' | 'cjs';
  platform?: 'node' | 'browser';
  target?: string | undefined;
  dts?: boolean;
  sourcemap?: boolean;
  fixedExtension?: boolean | undefined;
  clean?: boolean | string[] | undefined;
  external?: (string | RegExp)[];
  noExternal?: (id: string) => true | undefined;
  deps?: { neverBundle?: (string | RegExp)[]; alwaysBundle?: (id: string) => true | undefined };
  define?: Record<string, string> | undefined;
  entryFileNames?: string | undefined;
  plugins?: object[];
  outputOptions?: { entryFileNames: string; banner: string; intro: string; footer: string };
}
export interface HostOptions extends BuildOptions { dependencyMode?: 'legacy' | 'deps' }
export interface ClientOptions extends BuildOptions {
  id: string;
  modules?: 'minimal' | 'web' | readonly string[];
  dependencyMode?: 'legacy' | 'deps';
  purity?: false | { name?: string; allow?: RegExp[]; message?: string };
}
export const PLATFORM_MODULES: Readonly<{ minimal: readonly string[]; web: readonly string[] }>;
export function packageId(url: string | URL): string;
export function hostConfig(options?: HostOptions): BuildOptions;
export function clientConfig(options: ClientOptions): BuildOptions;
