/* 极简 TS 运行器：用 typescript 转译后以 CommonJS 跑指定的 .ts 脚本。
   用法：node scripts/run-ts.cjs scripts/verify-archive.ts */
const path = require('node:path')
const fs = require('node:fs')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const entry = process.argv[2]
if (!entry) {
  console.error('用法：node scripts/run-ts.cjs <脚本.ts>')
  process.exit(1)
}

const cache = {}
function load(file) {
  const abs = path.resolve(file)
  if (cache[abs]) return cache[abs].exports
  const source = fs.readFileSync(abs, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  cache[abs] = module
  const localRequire = (spec) => {
    if (spec.startsWith('@/')) return load(path.join(ROOT, 'src', spec.slice(2)) + '.ts')
    if (spec.startsWith('.')) return load(path.resolve(path.dirname(abs), spec) + '.ts')
    return require(spec)
  }
  new Function('require', 'module', 'exports', js)(localRequire, module, module.exports)
  return module.exports
}

load(path.resolve(ROOT, entry))
