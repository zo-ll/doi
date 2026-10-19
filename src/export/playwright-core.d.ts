// The part of playwright-core's internal bundle that browser.ts uses. The package has no types for it.
declare module "playwright-core/lib/coreBundle" {
  interface Executable {
    name: string;
  }
  export const registry: {
    runOopDownloadBrowserMain(): void;
    registry: {
      resolveBrowsers(names: string[], options: object): Executable[];
      install(executables: Executable[], options: { force: boolean }): Promise<void>;
    };
  };
}
