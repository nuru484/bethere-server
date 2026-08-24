// src/lib/request-context.js
//
// Per-request correlation id available anywhere in the call chain without
// threading it through every signature: services that enqueue a job from a
// request read it here and stamp it on the job payload.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

/** Runs `fn` with `requestId` visible to everything it calls, sync or async. */
export const runWithRequestId = (requestId, fn) => storage.run(requestId, fn);

/** The current request's id, or undefined outside a request (jobs, scripts). */
export const getRequestId = () => storage.getStore();
