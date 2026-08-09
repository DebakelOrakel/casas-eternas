import type { WorkerInboundMessage } from './pipeline/messages'
import { dispatch, setEmitter } from './pipeline/runtime'

// The generator runs off the main thread: stepping an epoch and rendering the
// full 2048x1024 raster (a per-pixel query against every plate and every terrain
// feature — see elevationField.ts) is heavy enough that doing it synchronously
// stalls camera panning and input for the duration of every tick.
//
// This file is only the transport. All of the pipeline lives in pipeline/runtime.ts
// and knows nothing about workers, so it can also be driven directly from a test.
//
// `self` is typed loosely rather than via `/// <reference lib="webworker" />` —
// that lib's ambient globals (self, postMessage, MessageEvent, ...) conflict with
// the project tsconfig's "DOM" lib, which this file also picks up since it is
// under the single `src` tsconfig include.
declare const self: any

setEmitter((message, transfer) => {
  if (transfer) self.postMessage(message, transfer)
  else self.postMessage(message)
})

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  dispatch(event.data)
}
