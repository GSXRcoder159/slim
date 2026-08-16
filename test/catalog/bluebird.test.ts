import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Bluebird, {
  all,
  delay,
  Promise as BBPromise,
  promisify,
  race,
  reject,
  resolve,
} from "../../src/generate/catalog/bluebird.ts";

describe("bluebird catalog (native Promise)", () => {
  it("resolve / reject / all / race match native Promise", async () => {
    assert.equal(await resolve(7), 7);
    await assert.rejects(() => reject(new Error("nope")), { message: "nope" });
    assert.deepEqual(await all([1, Promise.resolve(2)]), [1, 2]);
    assert.equal(await race([Promise.resolve("a"), delay(50, "b")]), "a");
  });

  it("delay looks up setTimeout at call time and resolves the value", async () => {
    const original = globalThis.setTimeout;
    const waits: number[] = [];
    globalThis.setTimeout = ((cb: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      cb();
      return 0 as unknown as ReturnType<typeof original>;
    }) as typeof setTimeout;
    try {
      assert.equal(await delay(25, "later"), "later");
      assert.deepEqual(waits, [25]);
    } finally {
      globalThis.setTimeout = original;
    }
  });

  it("promisify lifts a node-style callback", async () => {
    function read(
      path: string,
      cb: (err: Error | null, data?: string) => void,
    ): void {
      if (path === "missing") cb(new Error("enoent"));
      else cb(null, `data:${path}`);
    }
    const readP = promisify(read);
    assert.equal(await readP("file.txt"), "data:file.txt");
    await assert.rejects(() => readP("missing"), { message: "enoent" });
  });

  it("preserves this when calling a promisified method", async () => {
    const obj = {
      prefix: "x",
      get(cb: (err: Error | null, v?: string) => void) {
        cb(null, this.prefix);
      },
    };
    const getP = promisify(obj.get);
    assert.equal(await getP.call(obj), "x");
  });

  it("exports a Promise-compatible constructor with the extra statics", async () => {
    assert.equal(BBPromise, Bluebird);
    const p = new BBPromise<number>((res) => res(1));
    assert.equal(await p, 1);
    assert.equal(typeof BBPromise.delay, "function");
    assert.equal(typeof BBPromise.promisify, "function");
  });
});
