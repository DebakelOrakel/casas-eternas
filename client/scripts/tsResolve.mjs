// A module-resolution hook for plain node: the generator's modules import
// each other WITHOUT extensions (`from './flowRouting'`), which Vite
// resolves and node does not. Node strips TypeScript types natively (the
// engine's modules use only erasable syntax), so with this one hook a
// worker thread can load the engine's worker entry directly — no bundler,
// no Vite server in the worker. Registered by engineWorkerHost.mjs.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
    const base = fileURLToPath(new URL(specifier, context.parentURL))
    for (const ext of ['.ts', '.mts', '.js', '.mjs']) {
      if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context)
    }
  }
  return next(specifier, context)
}
