/**
 * The one place onnxruntime-web is loaded and configured.
 *
 * ## Why the import is dynamic
 *
 * A top-level `import` of ORT killed the worker at boot — every request, even
 * ones that never touch a model, came back `WORKER_ERROR` in ~270 ms, while a
 * function that does not import ORT served fine. A static import gives you no
 * way to see why: the module never finishes evaluating, so there is no handler
 * left to catch anything. Loading it inside a `try` on first use turns a silent
 * boot crash into an error message in the response body.
 *
 * It is also better shape for an Edge Function. Requests that never reach a
 * model — a bad payload, a preflight — should not pay for the runtime at all.
 *
 * ## Why 1.16.3
 *
 * Every ORT build from 1.19 on ships **only** threaded WebAssembly. Their glue
 * allocates a shared `WebAssembly.Memory`, and this runtime refuses it even
 * though it does expose `SharedArrayBuffer`:
 *
 *   no available backend found. ERR: [wasm] TypeError:
 *   Creating a shared memory is not supported
 *   [numThreads=1 simd=undefined proxy=false SAB=true]
 *
 * `numThreads = 1` cannot help there, because no single-threaded binary exists
 * to fall back to. 1.16.3 still publishes real non-threaded builds, and its
 * loader picks one when `numThreads > 1 && isMultiThreadSupported()` is false —
 * so `numThreads = 1` selects `ort-wasm-simd.wasm`, which allocates ordinary
 * memory.
 *
 * Deno in a container has none of these restrictions, so newer versions pass
 * locally and fail only once deployed. Worth remembering before "upgrading".
 *
 * ## Why the CDN and not `npm:`
 *
 * The npm package carries seven `.wasm` binaries and the deploy bundler inlines
 * all of them — 22 MB, which the platform rejects with "request entity too
 * large". The CDN URL pulls in JavaScript only. The single binary that is
 * actually needed is fetched at cold start from the project's own private
 * bucket, through `configureWasm()`.
 */

/** The binary the loader asks for at `numThreads = 1`, `simd = true`. */
export const ORT_WASM_FILE = 'ort-wasm-simd.wasm';

/**
 * Documentation only — the import below must spell this out as a literal.
 *
 * The deploy step bundles what it can see statically. `import(SOME_CONST)` is
 * not visible to it, so the module never makes it into the bundle and the call
 * fails at runtime with "Module not found". A literal is bundled as a deferred
 * chunk, which keeps the laziness and still ships the code.
 */
export const ORT_SPECIFIER = 'https://esm.sh/onnxruntime-web@1.16.3?target=denonext';

// deno-lint-ignore no-explicit-any
type Ort = any;

let loading: Promise<Ort> | null = null;
let wasmUrl: string | null = null;

/**
 * Where the `.wasm` lives. Must be called before the first session is created —
 * after that the runtime is initialised and the path is never read again.
 */
export function configureWasm(url: string) {
  wasmUrl = url;
}

/** The configured runtime. Loaded once per instance, on first use. */
export function getOrt(): Promise<Ort> {
  if (!loading) {
    loading = (async () => {
      let ort: Ort;
      try {
        const module = await import('https://esm.sh/onnxruntime-web@1.16.3?target=denonext');
        ort = module.default ?? module;
      } catch (error) {
        throw new Error(
          'onnxruntime failed to load from ' + ORT_SPECIFIER + ': ' +
          String((error as Error)?.message ?? error)
        );
      }

      if (!ort?.env?.wasm) {
        throw new Error('onnxruntime loaded but exposed no env.wasm — wrong build?');
      }

      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      // The proxy worker would start a Worker this sandbox does not want.
      ort.env.wasm.proxy = false;
      // The models emit a wall of const-folding notices on load.
      ort.env.logLevel = 'error';

      if (wasmUrl) ort.env.wasm.wasmPaths = { [ORT_WASM_FILE]: wasmUrl };

      return ort;
    })().catch((error) => {
      // Never let one failure poison the instance for good.
      loading = null;
      throw error;
    });
  }
  return loading;
}
