import { isMainThread, parentPort, workerData, Worker } from 'worker_threads';
import os from 'os';
import wasm_ from '../../compiled/_node_bindings/plonk_wasm.cjs';
import { fileURLToPath } from 'url';
import { workers } from '../../../lib/proof-system/workers.js';
let url = import.meta.url;
let filename = url !== undefined ? fileURLToPath(url) : __filename;

/**
 * @type {import("../../compiled/node_bindings/plonk_wasm.cjs")}
 */
const wasm = wasm_;

export { wasm, withThreadPool };

let workersReadyResolve;
let workersReady;

// expose this globally so that it can be referenced from wasm
globalThis.startWorkers = startWorkers;
globalThis.terminateWorkers = terminateWorkers;

if (!isMainThread) {
  parentPort.postMessage({ type: 'wasm_bindgen_worker_ready' });
  wasm.wbg_rayon_start_worker(workerData.receiver);
}

// state machine to enable calling multiple functions that need a thread pool at once
let state = 'none'; // 'initializing', 'running', 'exiting'
let isNeededBy = 0;
let initializingPromise, exitingPromise;

async function withThreadPool(run) {
  isNeededBy++;
  // none, exiting -> initializing
  switch (state) {
    case 'none':
      initializingPromise = initThreadPool();
      state = 'initializing';
      break;
    case 'initializing':
    case 'running':
      break;
    case 'exiting':
      initializingPromise = exitingPromise.then(initThreadPool);
      state = 'initializing';
      break;
  }
  // initializing -> running
  await initializingPromise;
  initializingPromise = undefined;
  state = 'running';

  let result;
  try {
    result = await run();
  } finally {
    // running -> exiting IF we don't need to run longer
    isNeededBy--;
    switch (state) {
      case 'none':
      case 'initializing':
      case 'exiting':
        console.error('bug in thread pool state machine');
        break;
      case 'running':
        if (isNeededBy < 1) {
          exitingPromise = exitThreadPool();
          state = 'exiting';
          // exiting -> none IF we didn't move exiting -> initializing
          await exitingPromise;
          if (state === 'exiting') {
            exitingPromise = undefined;
            state = 'none';
          }
        }
        break;
    }
  }
  return result;
}

async function initThreadPool() {
  if (!isMainThread) return;
  workersReady = new Promise((resolve) => (workersReadyResolve = resolve));
  await wasm.initThreadPool(
    workers.numWorkers ?? os.availableParallelism() - 1,
    filename
  );
  await workersReady;
  workersReady = undefined;
}

async function exitThreadPool() {
  if (!isMainThread) return;
  await wasm.exitThreadPool();
}

/**
 * @type {Worker[]}
 */
let wasmWorkers = [];

async function startWorkers(src, memory, builder) {
  wasmWorkers = [];
  await Promise.all(
    Array.from({ length: builder.numThreads() }, () => {
      let worker = new Worker(src, {
        workerData: { memory, receiver: builder.receiver() },
      });
      wasmWorkers.push(worker);
      let target = worker;
      let type = 'wasm_bindgen_worker_ready';
      return new Promise((resolve) => {
        let done = false;
        target.on('message', function onMsg(data) {
          if (data == null || data.type !== type || done) return;
          done = true;
          resolve(worker);
        });
      });
    })
  );
  builder.build();
  workersReadyResolve();
}

async function terminateWorkers() {
  return Promise.all(wasmWorkers.map((w) => w.terminate())).then(
    () => (wasmWorkers = undefined)
  );
}
