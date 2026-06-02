import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../database/db";
import { getTelegramClient } from "./telegramClient";
import { resolveMissingTelegramIds } from "./telegramIdentityService";
import { getStudentBalanceSummary } from "./paymentBalanceService";

type ReminderLesson = {
  lesson_id: number;
  student_id: number;
  start_time: string;
  status: string;
  google_status: string | null;
  google_deleted_at: string | null;
  reminder_sent: number;
  reminder_sent_at: string | null;
  name_ru: string;
  is_active: number;
  telegram_username: string | null;
  telegram_id: string | null;
};

type ReminderResult = {
  scannedLessons: number;
  eligibleLessons: number;
  sentReminders: number;
  failedToSend: number;
  skippedAlreadyReminded: number;
  skippedNoTelegramTarget: number;
  skippedOutsideWindow: number;
  skippedStatus: number;
  skippedPastLessons: number;
  dryRun: boolean;
};

type ReminderTelegramClient = {
  sendMessage(target: string, input: { message: string }): Promise<unknown>;
  disconnect?(): Promise<void>;
};

type SendLessonReminderOptions = {
  client?: ReminderTelegramClient;
  dryRun?: boolean;
  skipResolveMissingTelegramIds?: boolean;
  now?: number;
};

function getPositiveNumberEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  const parsedValue = rawValue ? Number(rawValue) : NaN;

  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallback;
}

function isDryRun(): boolean {
  return process.env.REMINDER_DRY_RUN?.toLowerCase() !== "false";
}

function cleanUsername(username: string): string {
  return username.trim().replace(/^@/, "");
}

function getReminderTargets(lesson: ReminderLesson): string[] {
  const targets: string[] = [];
  if (lesson.telegram_username?.trim()) {
    targets.push(cleanUsername(lesson.telegram_username));
  }

  if (lesson.telegram_id?.trim()) {
    targets.push(lesson.telegram_id.trim());
  }

  return targets;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLessonTimestamp(startTime: string): string {
  return startTime.replace(/([+-]\d{2})$/, "$1:00");
}

function parseLessonTimestamp(startTime: string): number {
  return Date.parse(normalizeLessonTimestamp(startTime));
}

function getReminderMessageId(sentMessage: unknown): string | null {
  if (
    sentMessage &&
    typeof sentMessage === "object" &&
    "id" in sentMessage
  ) {
    const id = (sentMessage as { id?: unknown }).id;
    return id === undefined || id === null ? null : String(id);
  }

  return null;
}

function formatLessonDate(startTime: string): {
  weekday: string;
  day: string;
  month: string;
  time: string;
} {
  const timeZone = process.env.APP_TIMEZONE ?? "Europe/Moscow";
  const lessonDate = new Date(normalizeLessonTimestamp(startTime));

  return {
    weekday: new Intl.DateTimeFormat("ru-RU", {
      weekday: "long",
      timeZone,
    }).format(lessonDate),
    day: new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      timeZone,
    }).format(lessonDate),
    month: new Intl.DateTimeFormat("ru-RU", {
      month: "long",
      timeZone,
    }).format(lessonDate),
    time: new Intl.DateTimeFormat("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(lessonDate),
  };
}

function buildReminderMessage(lesson: ReminderLesson): string {
  const { weekday, day, month, time } = formatLessonDate(lesson.start_time);
  const balance = getStudentBalanceSummary(lesson.student_id);
  const debtMessage =
    balance.unpaid_amount > 0
      ? `

Также напоминаю: у вас есть неоплаченные уроки: ${balance.unpaid_lessons_count}.
Сумма: ${balance.unpaid_amount} ${balance.currency}.`
      : "";

  return `Привет, ${lesson.name_ru} 👋

У нас урок в ${weekday}, ${day} ${month}, в ${time}.

Ответь:
1 — да, я готов
2 — нет, нужно отменить

Можно ответить цифрой или словами.${debtMessage}`;
}

export async function sendLessonReminders(
  options: SendLessonReminderOptions = {}
): Promise<ReminderResult> {
  const now = options.now ?? Date.now();
  const lookaheadHours = getPositiveNumberEnv("REMINDER_LOOKAHEAD_HOURS", 24);
  const lookaheadUntil = now + lookaheadHours * 60 * 60 * 1000;
  const dryRun = options.dryRun ?? isDryRun();

  if (!dryRun && !options.skipResolveMissingTelegramIds) {
    await resolveMissingTelegramIds();
  }

  const lessons = db
    .prepare(
      `
        SELECT
          lessons.id AS lesson_id,
          students.id AS student_id,
          lessons.start_time,
          lessons.status,
          lessons.google_status,
          lessons.google_deleted_at,
          lessons.reminder_sent,
          lessons.reminder_sent_at,
          students.name_ru,
          students.is_active,
          students.telegram_username,
          students.telegram_id
        FROM lessons
        JOIN students ON students.id = lessons.student_id
      `
    )
    .all() as ReminderLesson[];

  const result: ReminderResult = {
    scannedLessons: lessons.length,
    eligibleLessons: 0,
    sentReminders: 0,
    failedToSend: 0,
    skippedAlreadyReminded: 0,
    skippedNoTelegramTarget: 0,
    skippedOutsideWindow: 0,
    skippedStatus: 0,
    skippedPastLessons: 0,
    dryRun,
  };
  const lessonsToSend: ReminderLesson[] = [];

  for (const lesson of lessons) {
    const startTime = parseLessonTimestamp(lesson.start_time);
    const logReminderDecision = (action: "sent" | "skipped", skipReason: string | null) => {
      console.log("Reminder lesson decision", {
        lesson_id: lesson.lesson_id,
        student_id: lesson.student_id,
        start_time: lesson.start_time,
        status: lesson.status,
        action,
        skip_reason: skipReason,
      });
    };

    if (lesson.status !== "scheduled") {
      result.skippedStatus += 1;
      logReminderDecision("skipped", "status_not_scheduled");
    } else if (lesson.google_status === "deleted" || lesson.google_deleted_at) {
      result.skippedStatus += 1;
      logReminderDecision("skipped", "google_event_deleted");
    } else if (lesson.reminder_sent !== 0 || lesson.reminder_sent_at) {
      result.skippedAlreadyReminded += 1;
      logReminderDecision("skipped", "already_reminded");
    } else if (Number.isNaN(startTime) || startTime <= now) {
      result.skippedPastLessons += 1;
      logReminderDecision("skipped", "past_lesson");
    } else if (startTime > lookaheadUntil) {
      result.skippedOutsideWindow += 1;
      logReminderDecision("skipped", "outside_window");
    } else if (
      lesson.is_active !== 1 ||
      getReminderTargets(lesson).length === 0
    ) {
      result.skippedNoTelegramTarget += 1;
      logReminderDecision(
        "skipped",
        lesson.is_active !== 1 ? "student_inactive" : "no_telegram_target"
      );
    } else {
      result.eligibleLessons += 1;
      lessonsToSend.push(lesson);
    }
  }

  if (dryRun) {
    for (const lesson of lessonsToSend) {
      const targets = getReminderTargets(lesson);
      console.log("Dry run reminder:");
      console.log({
        lessonId: lesson.lesson_id,
        targets,
        message: buildReminderMessage(lesson),
      });
    }

    return result;
  }

  const updateReminderSent = db.prepare(
    `
      UPDATE lessons
      SET reminder_sent = 1,
          reminder_sent_at = datetime('now'),
          reminder_message_id = ?,
          reminder_error = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `
  );
  const updateReminderError = db.prepare(
    `
      UPDATE lessons
      SET reminder_error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `
  );

  const client =
    options.client ??
    (await getTelegramClient("reminderService", {
      sendOnly: true,
    }));

  try {
    for (const lesson of lessonsToSend) {
      try {
        const targets = getReminderTargets(lesson);
        let sent = false;
        let lastError: unknown = null;

        for (const target of targets) {
          try {
            const sentMessage = await client.sendMessage(target, {
              message: buildReminderMessage(lesson),
            });
            const messageId = getReminderMessageId(sentMessage);
            updateReminderSent.run(messageId, lesson.lesson_id);
            sent = true;
            break;
          } catch (error) {
            lastError = error;
          }
        }

        if (!sent) {
          result.failedToSend += 1;
          updateReminderError.run(
            lastError
              ? getErrorMessage(lastError)
              : "No Telegram target available",
            lesson.lesson_id
          );
          console.warn("Reminder send failed for student; continuing", {
            studentId: lesson.student_id,
            studentNameRu: lesson.name_ru,
            telegramUsername: lesson.telegram_username,
            telegramId: lesson.telegram_id,
            lessonId: lesson.lesson_id,
            lessonStartTime: lesson.start_time,
            errorMessage: lastError
              ? getErrorMessage(lastError)
              : "No Telegram target available",
          });
          continue;
        }

        console.log("Reminder lesson decision", {
          lesson_id: lesson.lesson_id,
          student_id: lesson.student_id,
          start_time: lesson.start_time,
          status: lesson.status,
          action: "sent",
          skip_reason: null,
        });
        result.sentReminders += 1;
      } catch (error) {
        result.failedToSend += 1;
        updateReminderError.run(getErrorMessage(error), lesson.lesson_id);
        console.warn("Reminder send failed for student; continuing", {
          studentId: lesson.student_id,
          studentNameRu: lesson.name_ru,
          telegramUsername: lesson.telegram_username,
          telegramId: lesson.telegram_id,
          lessonId: lesson.lesson_id,
          lessonStartTime: lesson.start_time,
          errorMessage: getErrorMessage(error),
        });
      }
    }
  } finally {
    if (client.disconnect) {
      await client.disconnect();
      console.log("reminderService Telegram client disconnected", {
        pid: process.pid,
      });
    }
  }

  return result;
}

async function main() {
  try {
    const result = await sendLessonReminders();
    console.log("Reminder send completed:");
    console.log(result);
  } catch (error) {
    console.error("Reminder send failed:");
    console.error(error);
    process.exit(1);
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (currentFilePath === executedFilePath) {
  void main();
}
