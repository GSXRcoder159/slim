/** CommonJS companion for require() consumers of an ESM catalog/LLM slice. */

export function isCjsConsumer(file: string, packageType: string | undefined): boolean {
  if (file.endsWith(".cjs")) return true;
  if (file.endsWith(".js") && packageType !== "module") return true;
  return false;
}

export function emitCjsSource(
  ts: typeof import("typescript"),
  source: string,
  fileName: string,
): string {
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
    fileName,
  }).outputText;
  return (
    out +
    `\nconst _slimDefault = module.exports.default;\n` +
    `if (typeof _slimDefault === "function") {\n` +
    `  module.exports = Object.assign(_slimDefault, module.exports);\n` +
    `} else if (_slimDefault && typeof _slimDefault === "object") {\n` +
    `  Object.assign(module.exports, _slimDefault);\n` +
    `}\n`
  );
}
