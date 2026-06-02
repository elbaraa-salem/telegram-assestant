import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "telegram-assistant-reminder-binding-test-")
);

process.chdir(tempDir);
process.env.TG_API_ID = "1";
process.env.TG_API_HASH = "test-hash";
process.env.TG_PHONE = "+10000000000";
process.env.REMINDER_LOOKAHEAD_HOURS = "24";

const { db, repairGoogleDeletedScheduledLessons } = await import("../database/db");
const { sendLessonReminders } = await import("../services/reminderService");
const { findActiveScheduledRemindedLesson } = await import(
  "../services/telegramListener"
);

const now = Date.now();
let eventCounter = 0;

function toHourOnlyPlusSeven(date: Date): string {
  const plusSeven = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  return plusSeven.toISOString().slice(0, 19) + "+07";
}

function parseTestLessonTimestamp(startTime: string): number {
  return Date.parse(startTime.replace(/([+-]\d{2})$/, "$1:00"));
}

function insertStudent(overrides: Record<string, unknown> = {}): number {
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
        VALUES (?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      overrides.name_ru ?? "Бараа",
      overrides.name_ar ?? "Baraa",
      overrides.telegram_username ?? "@baraa",
      overrides.telegram_id ?? "10001",
      overrides.calendar_keyword ?? `student-${Date.now()}-${Math.random()}`,
      overrides.is_active ?? 1
    );

  return Number(result.lastInsertRowid);
}

function insertLesson(
  studentId: number,
  overrides: Record<string, unknown> = {}
): number {
  eventCounter += 1;
  const startTime =
    overrides.start_time ?? new Date(now + eventCounter * 60 * 60 * 1000).toISOString();
  const endTime =
    overrides.end_time ??
    new Date(parseTestLessonTimestamp(String(startTime)) + 60 * 60 * 1000).toISOString();

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
          google_status,
          google_deleted_at,
          reminder_sent,
          reminder_sent_at,
          reminder_message_id,
          student_response,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `
    )
    .run(
      overrides.google_event_id ?? `event-${eventCounter}`,
      studentId,
      overrides.title ?? "lesson",
      startTime,
      endTime,
      overrides.status ?? "scheduled",
      overrides.google_status ?? null,
      overrides.google_deleted_at ?? null,
      overrides.reminder_sent ?? 0,
      overrides.reminder_sent_at ?? null,
      overrides.reminder_message_id ?? null,
      overrides.student_response ?? null
    );

  return Number(result.lastInsertRowid);
}

const studentId = insertStudent();
const cancelledLessonId = insertLesson(studentId, {
  status: "cancelled",
  start_time: toHourOnlyPlusSeven(new Date(now + 60 * 60 * 1000)),
});
const scheduledLessonId = insertLesson(studentId, {
  status: "scheduled",
  start_time: toHourOnlyPlusSeven(new Date(now + 2 * 60 * 60 * 1000)),
});

const sentTargets: string[] = [];
const result = await sendLessonReminders({
  dryRun: false,
  skipResolveMissingTelegramIds: true,
  now,
  client: {
    async sendMessage(target: string) {
      sentTargets.push(target);
      return { id: 7001 };
    },
  },
});

assert.equal(result.sentReminders, 1);
assert.equal(result.skippedStatus, 1);
assert.deepEqual(sentTargets, ["baraa"]);

const cancelledReminder = db
  .prepare("SELECT reminder_sent_at FROM lessons WHERE id = ?")
  .get(cancelledLessonId) as { reminder_sent_at: string | null };
assert.equal(cancelledReminder.reminder_sent_at, null);

const scheduledReminder = db
  .prepare(
    "SELECT reminder_sent, reminder_sent_at, reminder_message_id FROM lessons WHERE id = ?"
  )
  .get(scheduledLessonId) as {
  reminder_sent: number;
  reminder_sent_at: string | null;
  reminder_message_id: string | null;
};
assert.equal(scheduledReminder.reminder_sent, 1);
assert.ok(scheduledReminder.reminder_sent_at);
assert.equal(scheduledReminder.reminder_message_id, "7001");

assert.equal(
  findActiveScheduledRemindedLesson(studentId)?.id,
  scheduledLessonId,
  "reply should select the scheduled reminded lesson when cancelled lessons exist"
);

const otherStudentId = insertStudent({
  telegram_username: "@other",
  telegram_id: "20002",
  calendar_keyword: "other-student",
});
const oldCancelledLessonId = insertLesson(otherStudentId, {
  status: "cancelled",
  reminder_sent: 1,
  reminder_sent_at: new Date(now - 60 * 60 * 1000).toISOString(),
  start_time: new Date(now + 60 * 60 * 1000).toISOString(),
});
const activeScheduledLessonId = insertLesson(otherStudentId, {
  status: "scheduled",
  reminder_sent: 1,
  reminder_sent_at: new Date(now - 30 * 60 * 1000).toISOString(),
  start_time: new Date(now + 90 * 60 * 1000).toISOString(),
});

assert.equal(
  findActiveScheduledRemindedLesson(otherStudentId)?.id,
  activeScheduledLessonId,
  "reply should never select a cancelled lesson if a scheduled reminded lesson exists"
);
assert.notEqual(
  findActiveScheduledRemindedLesson(otherStudentId)?.id,
  oldCancelledLessonId
);

db.prepare("UPDATE lessons SET student_response = 'ready' WHERE id = ?").run(
  activeScheduledLessonId
);
assert.equal(
  findActiveScheduledRemindedLesson(otherStudentId),
  null,
  "duplicate reply should not re-select a lesson that already has a response"
);

const sameDayStudentId = insertStudent({
  telegram_username: "@same_day",
  telegram_id: "30003",
  calendar_keyword: "same-day-student",
});
const firstSameDayLessonId = insertLesson(sameDayStudentId, {
  status: "scheduled",
  reminder_sent: 1,
  reminder_sent_at: new Date(now - 20 * 60 * 1000).toISOString(),
  start_time: toHourOnlyPlusSeven(new Date(now + 3 * 60 * 60 * 1000)),
});
insertLesson(sameDayStudentId, {
  status: "scheduled",
  reminder_sent: 1,
  reminder_sent_at: new Date(now - 10 * 60 * 1000).toISOString(),
  start_time: toHourOnlyPlusSeven(new Date(now + 4 * 60 * 60 * 1000)),
});

assert.equal(
  findActiveScheduledRemindedLesson(sameDayStudentId)?.id,
  firstSameDayLessonId,
  "multiple same-day lessons should bind to the earliest scheduled reminded lesson"
);

const legacyStudentId = insertStudent({
  telegram_username: "@legacy",
  telegram_id: "50005",
  calendar_keyword: "legacy-student",
});
insertLesson(legacyStudentId, {
  status: "cancelled",
  reminder_sent: 1,
  reminder_sent_at: null,
  start_time: toHourOnlyPlusSeven(new Date(now + 30 * 60 * 1000)),
});
const legacyScheduledLessonId = insertLesson(legacyStudentId, {
  status: "scheduled",
  reminder_sent: 1,
  reminder_sent_at: null,
  start_time: toHourOnlyPlusSeven(new Date(now + 60 * 60 * 1000)),
});

assert.equal(
  findActiveScheduledRemindedLesson(legacyStudentId)?.id,
  legacyScheduledLessonId,
  "transition reply selection should accept legacy scheduled reminder_sent rows"
);

const googleDeletedReplyStudentId = insertStudent({
  telegram_username: "@reply_deleted",
  telegram_id: "60006",
  calendar_keyword: "reply-deleted-student",
});
insertLesson(googleDeletedReplyStudentId, {
  status: "scheduled",
  reminder_sent: 1,
  reminder_sent_at: new Date(now - 10 * 60 * 1000).toISOString(),
  google_deleted_at: new Date(now - 5 * 60 * 1000).toISOString(),
  start_time: toHourOnlyPlusSeven(new Date(now + 30 * 60 * 1000)),
});
const replyActiveLessonId = insertLesson(googleDeletedReplyStudentId, {
  status: "scheduled",
  reminder_sent: 1,
  reminder_sent_at: new Date(now - 8 * 60 * 1000).toISOString(),
  start_time: toHourOnlyPlusSeven(new Date(now + 90 * 60 * 1000)),
});

assert.equal(
  findActiveScheduledRemindedLesson(googleDeletedReplyStudentId)?.id,
  replyActiveLessonId,
  "google-deleted reminded lessons should not block active scheduled lessons"
);

const inconsistentLessonId = insertLesson(googleDeletedReplyStudentId, {
  status: "scheduled",
  reminder_sent: 1,
  reminder_sent_at: new Date(now - 6 * 60 * 1000).toISOString(),
  google_deleted_at: new Date(now - 5 * 60 * 1000).toISOString(),
  start_time: toHourOnlyPlusSeven(new Date(now + 2 * 60 * 60 * 1000)),
});
repairGoogleDeletedScheduledLessons();
const repairedLesson = db
  .prepare("SELECT status, cancellation_source FROM lessons WHERE id = ?")
  .get(inconsistentLessonId) as {
  status: string;
  cancellation_source: string | null;
};
assert.equal(repairedLesson.status, "cancelled");
assert.equal(repairedLesson.cancellation_source, "teacher");

const deletedOnlyStudentId = insertStudent({
  telegram_username: "@deleted_only",
  telegram_id: "70007",
  calendar_keyword: "deleted-only-student",
});
insertLesson(deletedOnlyStudentId, {
  status: "scheduled",
  reminder_sent: 1,
  reminder_sent_at: new Date(now - 10 * 60 * 1000).toISOString(),
  google_deleted_at: new Date(now - 5 * 60 * 1000).toISOString(),
  start_time: toHourOnlyPlusSeven(new Date(now + 60 * 60 * 1000)),
});
assert.equal(
  findActiveScheduledRemindedLesson(deletedOnlyStudentId),
  null,
  "reply to an old reminder after Google deletion should not select a lesson"
);

const deletedStudentId = insertStudent({
  telegram_username: "@deleted",
  telegram_id: "40004",
  calendar_keyword: "deleted-student",
});
insertLesson(deletedStudentId, {
  status: "scheduled",
  google_status: "deleted",
  google_deleted_at: new Date(now - 5 * 60 * 1000).toISOString(),
  start_time: new Date(now + 5 * 60 * 60 * 1000).toISOString(),
});

const deletedResult = await sendLessonReminders({
  dryRun: false,
  skipResolveMissingTelegramIds: true,
  now,
  client: {
    async sendMessage() {
      throw new Error("deleted lesson should not be sent");
    },
  },
});

assert.equal(deletedResult.sentReminders, 0);

console.log("reminder lesson binding tests passed");
