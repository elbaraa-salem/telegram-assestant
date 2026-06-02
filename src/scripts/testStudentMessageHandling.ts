import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "telegram-assistant-message-handling-test-")
);

process.chdir(tempDir);
process.env.TG_API_ID = "1";
process.env.TG_API_HASH = "test-hash";
process.env.TG_PHONE = "+10000000000";

const { classifyStudentTextForLesson, safeResolveInputEntity } = await import(
  "../services/telegramListener"
);

type TestLesson = Parameters<typeof classifyStudentTextForLesson>[0];

function lesson(overrides: Partial<TestLesson> = {}): TestLesson {
  return {
    id: 1,
    start_time: "2026-06-02T10:00:00+07:00",
    status: "scheduled",
    reminder_sent: 1,
    reminder_sent_at: "2026-06-01T10:00:00.000Z",
    student_response: null,
    awaiting_cancellation_reason: 0,
    cancellation_reason: null,
    ...overrides,
  };
}

function assertIgnoredSilently(inputLesson: TestLesson, text: string): void {
  const result = classifyStudentTextForLesson(inputLesson, text);

  assert.equal(result.intent, "unknown", text);
  assert.equal(result.shouldSendUnknownReminderReply, false, text);
}

const pendingLesson = lesson();
const readyLesson = lesson({
  status: "confirmed",
  student_response: "ready",
});

assert.deepEqual(classifyStudentTextForLesson(pendingLesson, "1"), {
  state: "awaiting_reminder_response",
  intent: "ready",
  shouldSendUnknownReminderReply: false,
});

assertIgnoredSilently(readyLesson, "أين نلتقي؟");
assertIgnoredSilently(readyLesson, "ахахахаха");
assertIgnoredSilently(readyLesson, "فين اللينك؟");

assert.equal(
  classifyStudentTextForLesson(
    readyLesson,
    "у меня проблема, я не успею, можем отменить?"
  ).intent,
  "cancel"
);

assertIgnoredSilently(readyLesson, "أنا عاوز أنام");
assertIgnoredSilently(readyLesson, "عاوزة أتجوز");

assert.deepEqual(classifyStudentTextForLesson(pendingLesson, "2"), {
  state: "awaiting_reminder_response",
  intent: "cancel",
  shouldSendUnknownReminderReply: false,
});

assertIgnoredSilently(lesson({ reminder_sent: 0 }), "какой-то текст");

const awaitingReasonLesson = lesson({
  awaiting_cancellation_reason: 1,
});
assert.deepEqual(
  classifyStudentTextForLesson(awaitingReasonLesson, "у меня экзамен утром"),
  {
    state: "awaiting_cancellation_reason",
    intent: "cancellation_reason",
    shouldSendUnknownReminderReply: false,
  }
);
assertIgnoredSilently(
  lesson({
    status: "cancellation_requested",
    student_response: "not_ready",
    awaiting_cancellation_reason: 0,
    cancellation_reason: "у меня экзамен утром",
  }),
  "صباح الخير"
);

assert.equal(classifyStudentTextForLesson(pendingLesson, "я готов").intent, "ready");
assert.notEqual(
  classifyStudentTextForLesson(pendingLesson, "я готов").intent,
  "completed"
);

let dialogsRefreshes = 0;
const unresolvedClient = {
  async getInputEntity() {
    throw new Error(
      'Could not find the input entity for {"userId":"1509372220","className":"PeerUser"}.'
    );
  },
  async getDialogs() {
    dialogsRefreshes += 1;
    return [];
  },
};

assert.equal(
  await safeResolveInputEntity(
    unresolvedClient as Parameters<typeof safeResolveInputEntity>[0],
    ["1509372220"]
  ),
  null
);
assert.equal(dialogsRefreshes, 1);

const resolvedEntity = { className: "InputPeerUser" };
const resolvedClient = {
  async getInputEntity(target: string) {
    assert.equal(target, "10001");
    return resolvedEntity;
  },
  async getDialogs() {
    throw new Error("should not refresh dialogs for cached entity");
  },
};

assert.equal(
  await safeResolveInputEntity(
    resolvedClient as unknown as Parameters<typeof safeResolveInputEntity>[0],
    ["10001"]
  ),
  resolvedEntity
);

console.log("student message handling tests passed");
