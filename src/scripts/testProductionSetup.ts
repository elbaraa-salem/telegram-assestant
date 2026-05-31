import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.APP_MODE = "production";
process.env.ENABLE_TEST_SEED = "false";
process.env.GOOGLE_AUTH_MODE = "service_account";
process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = "config/google-service-account.json";
process.env.GOOGLE_CALENDAR_ID = "production-calendar@example.com";
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
  assert.equal(getCalendarAuthMode(), "service_account");
  assert.equal(getCalendarId(), "production-calendar@example.com");
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

  console.log("Production setup checks passed.");
} finally {
  db.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}
