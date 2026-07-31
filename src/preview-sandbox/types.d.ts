// Ambient type declarations for the preview-sandbox iframe.

declare module '@babel/standalone' {
  export function transform(
    code: string,
    options?: {
      presets?: any[];
      plugins?: any[];
      filename?: string;
      sourceType?: 'module' | 'script';
    },
  ): { code?: string };
}
