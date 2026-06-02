import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.APP_MODE = "production";
process.env.ENABLE_TEST_SEED = "false";
process.env.GOOGLE_AUTH_MODE = "oauth";
process.env.GOOGLE_CREDENTIALS_FILE = "config/google-credentials.json";
process.env.GOOGLE_TOKEN_FILE = "config/google-token.json";
process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = "";
process.env.GOOGLE_CALENDAR_ID = "primary";
process.env.CALENDAR_SYNC_LOOKAHEAD_DAYS = "30";
process.env.CALENDAR_SYNC_LOOKBACK_DAYS = "7";

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "telegram-assistant-production-test-")
);

process.chdir(tempDir);

const { db } = await import("../database/db");
const {
  getCalendarAuthMode,
  getCalendarId,
  isInvalidGrantError,
  syncCalendarLessons,
} = await import("../services/calendarSync");

try {
  assert.equal(getCalendarAuthMode(), "oauth");
  assert.equal(getCalendarId(), "primary");
  assert.equal(isInvalidGrantError(new Error("invalid_grant")), true);

  await assert.rejects(
    async () => {
      await import("../scripts/seedTestStudent");
    },
    /Test student seeding is disabled/
  );

  const studentId = Number(
    db
      .prepare(
        `
          INSERT INTO students (
            name_ru,
            name_ar,
            telegram_username,
            telegram_id,
            calendar_keyword,
            lesson_price_amount,
            lesson_price_currency,
            is_active,
            created_at
          )
          VALUES ('Production Student', 'طالب', '@production_student', NULL, 'prod-key', 1000, 'RUB', 1, datetime('now'))
        `
      )
      .run().lastInsertRowid
  );

  const firstResult = await syncCalendarLessons({
    events: [
      {
        id: "calendar-event-1",
        summary: "prod-key lesson",
        status: "confirmed",
        start: { dateTime: "2026-06-02T10:00:00+07:00" },
        end: { dateTime: "2026-06-02T11:00:00+07:00" },
      },
    ],
  });
  assert.equal(firstResult.insertedLessons, 1);

  const secondResult = await syncCalendarLessons({
    events: [
      {
        id: "calendar-event-1",
        summary: "prod-key lesson",
        status: "confirmed",
        start: { dateTime: "2026-06-02T10:00:00+07:00" },
        end: { dateTime: "2026-06-02T11:00:00+07:00" },
      },
    ],
  });
  assert.equal(secondResult.insertedLessons, 0);
  assert.equal(secondResult.updatedLessons, 0);
  assert.deepEqual(
    db
      .prepare("SELECT COUNT(*) AS count FROM lessons WHERE google_event_id = ?")
      .get("calendar-event-1") as { count: number },
    { count: 1 }
  );

  db.prepare(
    `
      INSERT INTO lessons (
        google_event_id,
        student_id,
        title,
        start_time,
        end_time,
        status,
        google_status,
        updated_at
      )
      VALUES ('protected-completed', ?, 'old completed', '2026-06-03T10:00:00+07:00', '2026-06-03T11:00:00+07:00', 'completed', 'confirmed', datetime('now'))
    `
  ).run(studentId);
  db.prepare(
    `
      INSERT INTO lessons (
        google_event_id,
        student_id,
        title,
        start_time,
        end_time,
        status,
        google_status,
        updated_at
      )
      VALUES ('protected-cancelled', ?, 'old cancelled', '2026-06-04T10:00:00+07:00', '2026-06-04T11:00:00+07:00', 'cancelled', 'confirmed', datetime('now'))
    `
  ).run(studentId);

  const protectedResult = await syncCalendarLessons({
    events: [
      {
        id: "protected-completed",
        summary: "prod-key lesson changed",
        status: "confirmed",
        start: { dateTime: "2026-06-03T12:00:00+07:00" },
        end: { dateTime: "2026-06-03T13:00:00+07:00" },
      },
      {
        id: "protected-cancelled",
        summary: "prod-key lesson changed",
        status: "confirmed",
        start: { dateTime: "2026-06-04T12:00:00+07:00" },
        end: { dateTime: "2026-06-04T13:00:00+07:00" },
      },
    ],
  });
  assert.equal(protectedResult.skippedProtectedLessons, 2);

  const protectedRows = db
    .prepare(
      `
        SELECT google_event_id, title, status
        FROM lessons
        WHERE google_event_id IN ('protected-completed', 'protected-cancelled')
        ORDER BY google_event_id
      `
    )
    .all() as Array<{ google_event_id: string; title: string; status: string }>;

  assert.deepEqual(protectedRows, [
    {
      google_event_id: "protected-cancelled",
      title: "old cancelled",
      status: "cancelled",
    },
    {
      google_event_id: "protected-completed",
      title: "old completed",
      status: "completed",
    },
  ]);

  const insertLocalLesson = (input: {
    googleEventId: string;
    status?: string;
    startTime?: string;
    reminderSent?: number;
  }): number =>
    Number(
      db
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
              reminder_sent,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, datetime('now'))
          `
        )
        .run(
          input.googleEventId,
          studentId,
          input.googleEventId,
          input.startTime ?? "2026-06-05T10:00:00+07:00",
          "2026-06-05T11:00:00+07:00",
          input.status ?? "scheduled",
          input.reminderSent ?? 0
        ).lastInsertRowid
    );

  const untouchedLessonId = insertLocalLesson({ googleEventId: "delete-me" });
  const completedMissingLessonId = insertLocalLesson({
    googleEventId: "missing-completed",
    status: "completed",
  });
  const cancelledMissingLessonId = insertLocalLesson({
    googleEventId: "missing-cancelled",
    status: "cancelled",
  });
  const remindedMissingLessonId = insertLocalLesson({
    googleEventId: "missing-reminded",
    reminderSent: 1,
  });
  const chargedMissingLessonId = insertLocalLesson({
    googleEventId: "missing-charged",
  });
  const activeUnrelatedLessonId = insertLocalLesson({
    googleEventId: "still-in-calendar",
  });
  const outsideRangeLessonId = insertLocalLesson({
    googleEventId: "outside-range",
    startTime: "2026-08-15T10:00:00+07:00",
  });

  db.prepare(
    `
      INSERT INTO lesson_charges (
        lesson_id,
        student_id,
        charge_type,
        amount,
        currency,
        status,
        paid_amount,
        updated_at
      )
      VALUES (?, ?, 'lesson', 1000, 'RUB', 'unpaid', 0, datetime('now'))
    `
  ).run(chargedMissingLessonId, studentId);

  const deletedEventResult = await syncCalendarLessons({
    events: [
      {
        id: "calendar-event-1",
        summary: "prod-key lesson",
        status: "confirmed",
        start: { dateTime: "2026-06-02T10:00:00+07:00" },
        end: { dateTime: "2026-06-02T11:00:00+07:00" },
      },
      {
        id: "still-in-calendar",
        summary: "prod-key lesson",
        status: "confirmed",
        start: { dateTime: "2026-06-05T10:00:00+07:00" },
        end: { dateTime: "2026-06-05T11:00:00+07:00" },
      },
    ],
  });

  assert.equal(deletedEventResult.deletedUntouchedLessons, 1);
  assert.ok(deletedEventResult.preservedDeletedCalendarLessons >= 4);
  assert.equal(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM lessons WHERE id = ?")
        .get(untouchedLessonId) as { count: number }
    ).count,
    0
  );

  for (const lessonId of [
    completedMissingLessonId,
    cancelledMissingLessonId,
    remindedMissingLessonId,
    chargedMissingLessonId,
    activeUnrelatedLessonId,
    outsideRangeLessonId,
  ]) {
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM lessons WHERE id = ?")
          .get(lessonId) as { count: number }
      ).count,
      1
    );
  }

  const remindedDeletedLesson = db
    .prepare(
      `
        SELECT status, cancellation_source, google_deleted_at, reminder_sent
        FROM lessons
        WHERE id = ?
      `
    )
    .get(remindedMissingLessonId) as {
    status: string;
    cancellation_source: string | null;
    google_deleted_at: string | null;
    reminder_sent: number;
  };
  assert.equal(remindedDeletedLesson.status, "cancelled");
  assert.equal(remindedDeletedLesson.cancellation_source, "teacher");
  assert.ok(remindedDeletedLesson.google_deleted_at);
  assert.equal(remindedDeletedLesson.reminder_sent, 1);

  console.log("Production setup checks passed.");
} finally {
  db.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}
