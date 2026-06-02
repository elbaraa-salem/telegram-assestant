import { db } from "../database/db";
import { getTelegramClient } from "./telegramClient";
import {
  confirmSingleLessonChargeManually,
  createLessonChargeForCompletedLesson,
  createManualPaymentAndApply,
  getStudentBalanceSummary,
} from "./paymentBalanceService";

const protectedStatuses = new Set([
  "cancelled",
  "cancelled_by_student",
  "cancelled_by_teacher",
]);

type CompletionRow = {
  lesson_id: number;
  lesson_status: string;
  google_deleted_at: string | null;
  student_id: number;
  telegram_username: string | null;
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

function buildDebtMessage(unpaidLessonsCount: number, unpaidAmount: number, currency: string): string {
  const lessonWord =
    unpaidLessonsCount === 1 ? "неоплаченный урок" : "неоплаченные уроки";

  return `Урок отмечен как проведён ✅

У вас есть ${lessonWord}: ${unpaidLessonsCount}.
Сумма к оплате: ${unpaidAmount} ${currency}.

Пожалуйста, отправьте чек PDF-файлом.`;
}

function formatLessonCountRu(count: number): string {
  const absoluteCount = Math.abs(count);
  const lastTwoDigits = absoluteCount % 100;
  const lastDigit = absoluteCount % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return `${count} уроков`;
  }

  if (lastDigit === 1) {
    return `${count} урок`;
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return `${count} урока`;
  }

  return `${count} уроков`;
}

function buildPrepaidMessage(prepaidLessonsCount: number): string {
  return `Урок отмечен как проведён ✅

Оплата списана из вашего баланса.
Осталось оплаченных уроков: ${formatLessonCountRu(prepaidLessonsCount)}.`;
}

export async function completeLesson(lessonId: number): Promise<boolean> {
  const lesson = db
    .prepare(
      `
        SELECT
          lessons.id AS lesson_id,
          lessons.status AS lesson_status,
          lessons.google_deleted_at,
          students.id AS student_id,
          students.telegram_username
        FROM lessons
        JOIN students ON students.id = lessons.student_id
        WHERE lessons.id = ?
      `
    )
    .get(lessonId) as CompletionRow | undefined;

  if (
    !lesson ||
    lesson.lesson_status === "completed" ||
    lesson.google_deleted_at ||
    protectedStatuses.has(lesson.lesson_status)
  ) {
    return false;
  }

  const completionResult = db.transaction(() => {
    db.prepare(
      `
        UPDATE lessons
        SET status = 'completed',
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(lessonId);

    const charge = createLessonChargeForCompletedLesson(lessonId);
    const summary = getStudentBalanceSummary(lesson.student_id);

    db.prepare(
      `
        UPDATE lessons
        SET payment_request_sent = ?
        WHERE id = ?
      `
    ).run(summary.unpaid_amount > 0 ? 1 : 0, lessonId);

    return { charge, summary };
  })();

  if (completionResult.summary.unpaid_amount > 0) {
    await sendStudentMessage(
      lesson.telegram_username,
      buildDebtMessage(
        completionResult.summary.unpaid_lessons_count,
        completionResult.summary.unpaid_amount,
        completionResult.summary.currency
      ),
      `Lesson ${lessonId} completed with debt`
    );
    return true;
  }

  console.log("existing prepaid balance applied to completed lesson", {
    lessonId,
    studentId: lesson.student_id,
    prepaidLessonsCount: completionResult.summary.prepaid_lessons_count,
  });
  console.log("payment request skipped because lesson was covered by balance", {
    lessonId,
    studentId: lesson.student_id,
  });

  await sendStudentMessage(
    lesson.telegram_username,
    buildPrepaidMessage(completionResult.summary.prepaid_lessons_count),
    `Lesson ${lessonId} completed using balance`
  );

  return true;
}

export async function confirmLessonPayment(lessonId: number): Promise<boolean> {
  const lesson = db
    .prepare(
      `
        SELECT
          lessons.id AS lesson_id,
          students.telegram_username
        FROM lessons
        JOIN students ON students.id = lessons.student_id
        WHERE lessons.id = ?
      `
    )
    .get(lessonId) as
    | {
        lesson_id: number;
        telegram_username: string | null;
      }
    | undefined;

  if (!lesson) {
    return false;
  }

  const result = confirmSingleLessonChargeManually(lessonId);

  if (!result) {
    return false;
  }

  await sendStudentMessage(
    lesson.telegram_username,
    "Оплата за урок подтверждена ✅ Спасибо!",
    `Payment for lesson ${lessonId} confirmed`
  );

  return true;
}

export function addManualStudentPayment(
  studentId: number,
  amount: number,
  currency: string
) {
  return createManualPaymentAndApply(studentId, amount, currency);
}
