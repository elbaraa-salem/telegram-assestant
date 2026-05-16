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

type ActivePackage = {
  id: number;
  total_lessons: number;
  used_lessons: number;
};

function cleanTelegramTarget(username: string | null): string | null {
  const target = username?.trim().replace(/^@/, "");
  return target || null;
}

async function sendStudentMessage(
  username: string | null,
  message: string,
  logPrefix: string
): Promise<void> {
  const target = cleanTelegramTarget(username);

  if (!target) {
    console.error(`${logPrefix}, but student has no Telegram username.`);
    return;
  }

  try {
    const client = await getTelegramClient("lessonCompletionService", {
      sendOnly: true,
    });

    try {
      await client.sendMessage(target, { message });
    } finally {
      await client.disconnect();
      console.log("lessonCompletionService Telegram client disconnected", {
        pid: process.pid,
      });
    }
  } catch (error) {
    console.error(`${logPrefix}, but Telegram send failed:`);
    console.error(error);
  }
}

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

  if (
    !lesson ||
    lesson.lesson_status === "completed" ||
    protectedStatuses.has(lesson.lesson_status)
  ) {
    return false;
  }

  let consumedPackage:
    | {
        usedLessons: number;
        totalLessons: number;
        remainingLessons: number;
        completed: boolean;
      }
    | undefined;

  const completeTransaction = db.transaction(() => {
    const activePackage = db
      .prepare(
        `
          SELECT id, total_lessons, used_lessons
          FROM lesson_packages
          WHERE student_id = ?
            AND status = 'active'
            AND used_lessons < total_lessons
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `
      )
      .get(lesson.student_id) as ActivePackage | undefined;

    db.prepare(
      `
        UPDATE lessons
        SET status = 'completed',
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(lessonId);

    if (activePackage) {
      const usedLessons = activePackage.used_lessons + 1;
      const completed = usedLessons >= activePackage.total_lessons;

      db.prepare(
        `
          UPDATE lesson_packages
          SET used_lessons = ?,
              status = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `
      ).run(
        usedLessons,
        completed ? "completed" : "active",
        activePackage.id
      );

      db.prepare(
        `
          UPDATE payments
          SET status = 'confirmed',
              paid_at = datetime('now'),
              prepaid_package_id = ?,
              payment_method = 'package',
              updated_at = datetime('now')
          WHERE id = ?
        `
      ).run(activePackage.id, lesson.payment_id);

      consumedPackage = {
        usedLessons,
        totalLessons: activePackage.total_lessons,
        remainingLessons: activePackage.total_lessons - usedLessons,
        completed,
      };
      return;
    }

    db.prepare(
      `
        UPDATE lessons
        SET payment_request_sent = 1
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

  if (consumedPackage) {
    const packageMessage = `Урок проведён ✅

Списан 1 урок из оплаченного пакета.
Использовано: ${consumedPackage.usedLessons} из ${consumedPackage.totalLessons}.
Осталось: ${consumedPackage.remainingLessons}.${consumedPackage.completed ? "\nПакет закончился." : ""}`;

    await sendStudentMessage(
      lesson.telegram_username,
      packageMessage,
      `Lesson ${lessonId} completed using package`
    );
    return true;
  }

  await sendStudentMessage(
    lesson.telegram_username,
    `Урок отмечен как проведён ✅

Пожалуйста, отправь чек об оплате за этот урок PDF-файлом.`,
    `Lesson ${lessonId} completed`
  );

  return true;
}

export async function confirmLessonPayment(lessonId: number): Promise<boolean> {
  const lesson = db
    .prepare(
      `
        SELECT
          lessons.id AS lesson_id,
          students.telegram_username,
          payments.id AS payment_id
        FROM lessons
        JOIN students ON students.id = lessons.student_id
        JOIN payments ON payments.lesson_id = lessons.id
        WHERE lessons.id = ?
      `
    )
    .get(lessonId) as
    | {
        lesson_id: number;
        telegram_username: string | null;
        payment_id: number;
      }
    | undefined;

  if (!lesson) {
    return false;
  }

  db.transaction(() => {
    db.prepare(
      `
        UPDATE payments
        SET status = 'confirmed',
            paid_at = datetime('now'),
            payment_method = 'manual',
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(lesson.payment_id);
  })();

  await sendStudentMessage(
    lesson.telegram_username,
    "Оплата за урок подтверждена ✅ Спасибо!",
    `Payment for lesson ${lessonId} confirmed`
  );

  return true;
}
