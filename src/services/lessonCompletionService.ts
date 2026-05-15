import { db } from "../database/db";
import { getTelegramClient } from "./telegramClient";

const protectedStatuses = new Set([
  "cancelled_by_student",
  "cancelled_by_teacher",
]);

type CompletionRow = {
  lesson_id: number;
  lesson_status: string;
  student_id: number;
  telegram_username: string | null;
  payment_id: number;
};

export async function completeLesson(lessonId: number): Promise<boolean> {
  const lesson = db
    .prepare(
      `
        SELECT
          lessons.id AS lesson_id,
          lessons.status AS lesson_status,
          students.id AS student_id,
          students.telegram_username,
          payments.id AS payment_id
        FROM lessons
        JOIN students ON students.id = lessons.student_id
        JOIN payments ON payments.lesson_id = lessons.id
        WHERE lessons.id = ?
      `
    )
    .get(lessonId) as CompletionRow | undefined;

  if (!lesson || protectedStatuses.has(lesson.lesson_status)) {
    return false;
  }

  const completeTransaction = db.transaction(() => {
    db.prepare(
      `
        UPDATE lessons
        SET status = 'completed',
            payment_request_sent = 1,
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(lessonId);

    db.prepare(
      `
        UPDATE payments
        SET status = 'requested',
            requested_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(lesson.payment_id);
  });

  completeTransaction();

  const target = lesson.telegram_username?.trim().replace(/^@/, "");

  if (!target) {
    console.error(`Lesson ${lessonId} completed, but student has no Telegram username.`);
    return true;
  }

  try {
    const client = await getTelegramClient();

    try {
      await client.sendMessage(target, {
        message: `Урок отмечен как проведён ✅

Пожалуйста, отправь чек об оплате за этот урок PDF-файлом.`,
      });
    } finally {
      await client.disconnect();
    }
  } catch (error) {
    console.error(`Lesson ${lessonId} completed, but Telegram send failed:`);
    console.error(error);
  }

  return true;
}
