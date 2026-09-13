// Jest transformer using the TypeScript compiler directly (no ts-jest dependency).
// Decorator metadata is required for Nest DI to work inside tests.
const ts = require('typescript');
const crypto = require('crypto');

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2021,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  sourceMap: true,
  inlineSourceMap: true,
  inlineSources: true,
};

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, { compilerOptions, fileName: sourcePath, reportDiagnostics: false });
    return { code: outputText };
  },
  getCacheKey(sourceText, sourcePath, options) {
    return crypto
      .createHash('sha1')
      .update(sourceText)
      .update(sourcePath)
      .update(JSON.stringify(compilerOptions))
      .update(options && options.configString ? options.configString : '')
      .digest('hex');
  },
};
