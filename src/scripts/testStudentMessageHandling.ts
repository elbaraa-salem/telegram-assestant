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

const { db } = await import("../database/db");
const {
  classifyStudentTextForLesson,
  processTelegramMessage,
  safeResolveInputEntity,
} = await import("../services/telegramListener");

type TestLesson = Parameters<typeof classifyStudentTextForLesson>[0];
type TestMessage = Parameters<typeof processTelegramMessage>[1];
type TestClient = Parameters<typeof processTelegramMessage>[0];

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

assertIgnoredSilently(
  readyLesson,
  "у меня проблема, я не успею, можем отменить?"
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

let messageId = 10_000;
let eventId = 0;

function insertStudent(telegramId: string): number {
  const result = db
    .prepare(
      `
        INSERT INTO students (
          name_ru,
          name_ar,
          telegram_username,
          telegram_id,
          calendar_keyword,
          is_active
        )
        VALUES (?, ?, ?, ?, ?, 1)
      `
    )
    .run(
      `Student ${telegramId}`,
      `Student ${telegramId}`,
      `@student_${telegramId}`,
      telegramId,
      `student-${telegramId}-${Date.now()}-${Math.random()}`
    );

  return Number(result.lastInsertRowid);
}

function insertRemindedLesson(
  studentId: number,
  overrides: Record<string, unknown> = {}
): number {
  eventId += 1;
  const startTime =
    overrides.start_time ??
    new Date(Date.now() + 6 * 60 * 60 * 1000 + eventId * 60_000).toISOString();
  const endTime =
    overrides.end_time ??
    new Date(Date.parse(String(startTime)) + 60 * 60 * 1000).toISOString();

  const result = db
    .prepare(
      `
        INSERT INTO lessons (
          google_event_id,
          student_id,
          title,
          start_time,
          end_time,
          status,
          reminder_sent,
          reminder_sent_at,
          student_response,
          awaiting_cancellation_reason,
          cancellation_reason,
          updated_at
        )
        VALUES (?, ?, 'lesson', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `
    )
    .run(
      `message-handling-event-${eventId}`,
      studentId,
      startTime,
      endTime,
      overrides.status ?? "scheduled",
      overrides.reminder_sent ?? 1,
      overrides.reminder_sent_at ?? new Date().toISOString(),
      overrides.student_response ?? null,
      overrides.awaiting_cancellation_reason ?? 0,
      overrides.cancellation_reason ?? null
    );

  return Number(result.lastInsertRowid);
}

function createTextMessage(senderId: string, text: string): TestMessage {
  messageId += 1;

  return {
    id: messageId,
    senderId,
    chatId: senderId,
    date: Math.floor(Date.now() / 1000),
    out: false,
    message: text,
    media: undefined,
    document: undefined,
  } as unknown as TestMessage;
}

function createClient(sentMessages: string[]): TestClient {
  return {
    async getInputEntity(target: string) {
      return target;
    },
    async getDialogs() {
      return [];
    },
    async sendMessage(_entity: unknown, input: { message: string }) {
      sentMessages.push(input.message);
      return { id: messageId + 1 };
    },
  } as unknown as TestClient;
}

async function assertNoOutgoingMessage(
  text: string,
  description: string
): Promise<void> {
  const telegramId = String(80_000 + messageId);
  insertStudent(telegramId);
  const sentMessages: string[] = [];

  const action = await processTelegramMessage(
    createClient(sentMessages),
    createTextMessage(telegramId, text),
    "event"
  );

  assert.equal(action, "ignored", description);
  assert.deepEqual(sentMessages, [], description);
}

await assertNoOutgoingMessage("Да", "no pending interaction + Да is silent");
await assertNoOutgoingMessage("готов", "no pending interaction + готов is silent");
await assertNoOutgoingMessage("1", "no pending interaction + 1 is silent");
await assertNoOutgoingMessage(
  "Привет, в след воскресенье готов, в это не смогу",
  "no pending interaction + arbitrary text is silent"
);

const expiredPendingTelegramId = "91001";
const expiredPendingStudentId = insertStudent(expiredPendingTelegramId);
const expiredPendingLessonId = insertRemindedLesson(expiredPendingStudentId, {
  start_time: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  end_time: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
});
const expiredSentMessages: string[] = [];
const expiredAction = await processTelegramMessage(
  createClient(expiredSentMessages),
  createTextMessage(expiredPendingTelegramId, "Да"),
  "event"
);
const expiredLesson = db
  .prepare("SELECT student_response FROM lessons WHERE id = ?")
  .get(expiredPendingLessonId) as { student_response: string | null };
assert.equal(expiredAction, "ignored");
assert.deepEqual(expiredSentMessages, []);
assert.equal(expiredLesson.student_response, null);

const validPendingTelegramId = "91002";
const validPendingStudentId = insertStudent(validPendingTelegramId);
const validPendingLessonId = insertRemindedLesson(validPendingStudentId);
const validSentMessages: string[] = [];
const validAction = await processTelegramMessage(
  createClient(validSentMessages),
  createTextMessage(validPendingTelegramId, "1"),
  "event"
);
const confirmedLesson = db
  .prepare("SELECT status, student_response FROM lessons WHERE id = ?")
  .get(validPendingLessonId) as {
  status: string;
  student_response: string | null;
};
assert.equal(validAction, "confirmed_lesson");
assert.deepEqual(validSentMessages, ["Отлично, до встречи на уроке ✅"]);
assert.equal(confirmedLesson.status, "confirmed");
assert.equal(confirmedLesson.student_response, "ready");

const invalidPendingTelegramId = "91003";
const invalidPendingStudentId = insertStudent(invalidPendingTelegramId);
const invalidPendingLessonId = insertRemindedLesson(invalidPendingStudentId);
const invalidSentMessages: string[] = [];
const invalidAction = await processTelegramMessage(
  createClient(invalidSentMessages),
  createTextMessage(invalidPendingTelegramId, "привет"),
  "event"
);
const unchangedPendingLesson = db
  .prepare(
    `
      SELECT status, student_response, awaiting_cancellation_reason
      FROM lessons
      WHERE id = ?
    `
  )
  .get(invalidPendingLessonId) as {
  status: string;
  student_response: string | null;
  awaiting_cancellation_reason: number;
};
assert.equal(invalidAction, "ignored");
assert.deepEqual(invalidSentMessages, []);
assert.equal(unchangedPendingLesson.status, "scheduled");
assert.equal(unchangedPendingLesson.student_response, null);
assert.equal(unchangedPendingLesson.awaiting_cancellation_reason, 0);

const reasonPendingTelegramId = "91004";
const reasonPendingStudentId = insertStudent(reasonPendingTelegramId);
const reasonPendingLessonId = insertRemindedLesson(reasonPendingStudentId, {
  student_response: "not_ready",
  awaiting_cancellation_reason: 1,
});
const reasonSentMessages: string[] = [];
const reasonAction = await processTelegramMessage(
  createClient(reasonSentMessages),
  createTextMessage(reasonPendingTelegramId, "у меня экзамен утром"),
  "event"
);
const reasonLesson = db
  .prepare(
    `
      SELECT awaiting_cancellation_reason, cancellation_reason
      FROM lessons
      WHERE id = ?
    `
  )
  .get(reasonPendingLessonId) as {
  awaiting_cancellation_reason: number;
  cancellation_reason: string | null;
};
assert.equal(reasonAction, "cancellation_reason");
assert.deepEqual(reasonSentMessages, [
  "Спасибо, я получил причину. Я посмотрю и отвечу вручную.",
]);
assert.equal(reasonLesson.awaiting_cancellation_reason, 0);
assert.equal(reasonLesson.cancellation_reason, "у меня экзамен утром");

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
