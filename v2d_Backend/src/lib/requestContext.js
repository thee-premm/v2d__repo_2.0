import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export const requestContext = {
  run(ctx, fn) {
    return storage.run(ctx, fn);
  },
  get() {
    return storage.getStore() ?? null;
  },
};
