/** CommonJS companion for require() consumers of an ESM catalog/LLM slice. */
export declare function isCjsConsumer(file: string, packageType: string | undefined): boolean;
export declare function emitCjsSource(ts: typeof import("typescript"), source: string, fileName: string): string;
