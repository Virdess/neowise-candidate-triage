import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createAppServer, triage } from "../server.mjs";

let server;
let baseUrl;

before(async () => {
  server = createAppServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function post(body, raw = false) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const MANUAL = { status: "manual_review", topic: null, draft: null };

test("корректная заявка: 200 и ready с темой и черновиком", async () => {
  const { status, body } = await post({ text: "Когда будет доставка заказа?" });
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.ok(body.draft.trim().length > 0);
});

test("тема pricing распознаётся", async () => {
  const { body } = await post({ text: "Какая стоимость услуги?" });
  assert.equal(body.topic, "pricing");
});

for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${marker}: 200 и manual_review`, async () => {
    const { status, body } = await post({ text: `Заявка ${marker}` });
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL);
  });
}

test("таймаут модели: manual_review не дольше ~300 мс, а не 1200 мс", async () => {
  const started = performance.now();
  const { status, body } = await post({ text: "Заявка [timeout]" });
  const elapsed = performance.now() - started;
  assert.equal(status, 200);
  assert.deepEqual(body, MANUAL);
  assert.ok(elapsed < 800, `ответ занял ${Math.round(elapsed)} мс`);
});

test("таймаут срабатывает, даже если провайдер игнорирует AbortSignal", async () => {
  const hanging = () => new Promise(() => {});
  const started = performance.now();
  const result = await triage("текст", { classify: hanging, timeoutMs: 50 });
  assert.deepEqual(result, MANUAL);
  assert.ok(performance.now() - started < 500);
});

const invalidInputs = [
  ["пустая строка", { text: "" }],
  ["только пробелы", { text: "   " }],
  ["нет поля text", {}],
  ["text не строка", { text: 42 }],
  ["null вместо объекта", null],
];
for (const [name, payload] of invalidInputs) {
  test(`невалидный ввод (${name}): 400 invalid_input`, async () => {
    const { status, body } = await post(payload);
    assert.equal(status, 400);
    assert.deepEqual(body, { status: "invalid_input" });
  });
}

test("битый JSON: 400 invalid_input", async () => {
  const { status, body } = await post("{not json", true);
  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});
