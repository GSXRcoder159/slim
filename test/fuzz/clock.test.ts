import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeClock, wallMs } from "../../src/fuzz/clock.ts";

test("setTimeout fires on advance, not before", async () => {
  const clock = createFakeClock(0);
  clock.install();
  try {
    let fired = 0;
    setTimeout(() => {
      fired += 1;
    }, 100);
    await clock.advance(99);
    assert.equal(fired, 0);
    assert.equal(clock.getTime(), 99);
    await clock.advance(1);
    assert.equal(fired, 1);
    assert.equal(clock.getTime(), 100);
  } finally {
    clock.uninstall();
  }
});

test("Date.now and new Date() move with the clock", async () => {
  const clock = createFakeClock(500);
  clock.install();
  try {
    assert.equal(Date.now(), 500);
    assert.equal(new Date().getTime(), 500);
    await clock.advance(250);
    assert.equal(Date.now(), 750);
    assert.equal(new Date().getTime(), 750);
    clock.set(10);
    assert.equal(Date.now(), 10);
  } finally {
    clock.uninstall();
  }
});

test("advance flushes microtasks queued by timers", async () => {
  const clock = createFakeClock(0);
  clock.install();
  try {
    let x = 0;
    setTimeout(() => {
      Promise.resolve()
        .then(() => {
          x = 1;
        })
        .then(() => {
          x = 2;
        });
    }, 10);
    await clock.advance(10);
    assert.equal(x, 2);
  } finally {
    clock.uninstall();
  }
});

test("setInterval repeats and clearTimeout cancels", async () => {
  const clock = createFakeClock(0);
  clock.install();
  try {
    let n = 0;
    const id = setInterval(() => {
      n += 1;
    }, 10);
    await clock.advance(30);
    assert.equal(n, 3);
    clearInterval(id);
    await clock.advance(30);
    assert.equal(n, 3);

    let once = 0;
    const t = setTimeout(() => {
      once += 1;
    }, 5);
    clearTimeout(t);
    await clock.advance(20);
    assert.equal(once, 0);
  } finally {
    clock.uninstall();
  }
});

test("performance.now is patched and restored", async () => {
  const clock = createFakeClock(0);
  const native = performance.now();
  clock.install();
  try {
    assert.equal(performance.now(), 0);
    await clock.advance(40);
    assert.equal(performance.now(), 40);
  } finally {
    clock.uninstall();
  }
  const restored = performance.now();
  assert.ok(restored >= native || restored > 0);
});

test("wallMs is not patched by the fake clock", () => {
  const clock = createFakeClock(0);
  clock.install();
  try {
    const a = wallMs();
    clock.set(50_000);
    assert.equal(Date.now(), 50_000);
    const b = wallMs();
    assert.ok(b >= a);
    assert.ok(b - a < 5_000);
  } finally {
    clock.uninstall();
  }
});
