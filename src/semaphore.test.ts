import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "./semaphore.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("max 個 acquire 立即完成，第 max+1 個排隊直到 release", async () => {
  const sem = new Semaphore(2);
  await sem.acquire();
  await sem.acquire();

  let thirdResolved = false;
  const p3 = sem.acquire().then(() => {
    thirdResolved = true;
  });

  await sleep(10);
  assert.equal(thirdResolved, false, "名額用盡前第三個 acquire 不該提前完成");

  sem.release();
  await p3;
  assert.equal(thirdResolved, true);
});

test("release 依 FIFO 順序交給排隊者，不是誰先搶到誰贏", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();

  const order: number[] = [];
  const p1 = sem.acquire().then(() => order.push(1));
  const p2 = sem.acquire().then(() => order.push(2));

  sem.release();
  await p1;
  assert.deepEqual(order, [1], "release 後應先交給第一個排隊者");

  sem.release();
  await p2;
  assert.deepEqual(order, [1, 2]);
});

// plan_dispatch_v1.4.md §13：429 等待期間 release() 釋放名額給其他 spoke，等待結束後
// 重新 acquire()。這是「§19 需確認現成套件是否支援中途釋放」那條的自寫實作，直接驗證。
test("release → sleep → acquire 模式：等待期間名額真的釋放給其他排隊者，等完能重新取得", async () => {
  const sem = new Semaphore(1);
  await sem.acquire(); // 模擬某 spoke 持有唯一名額

  const events: string[] = [];
  const otherDone = sem.acquire().then(async () => {
    events.push("other-acquired");
    sem.release();
  });

  // 模擬 429：釋放名額、等待、重新取得
  sem.release();
  events.push("released-for-wait");
  await sleep(5);
  await sem.acquire();
  events.push("reacquired");

  await otherDone;
  assert.deepEqual(events, ["released-for-wait", "other-acquired", "reacquired"]);
});

test("release 次數多於 acquire 排隊數時，多出的名額累積供之後 acquire 使用", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();
  sem.release();
  sem.release(); // 沒有排隊者，available 累積為 2

  const start = Date.now();
  await sem.acquire();
  await sem.acquire();
  assert.ok(Date.now() - start < 50, "累積的名額應可連續 acquire 而不阻塞");
});
