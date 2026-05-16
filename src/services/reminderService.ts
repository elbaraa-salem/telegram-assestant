import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../database/db";
import { getTelegramClient } from "./telegramClient";
import { resolveMissingTelegramIds } from "./telegramIdentityService";

type ReminderLesson = {
  lesson_id: number;
  start_time: string;
  name_ru: string;
  telegram_username: string | null;
  telegram_id: string | null;
};

type ReminderResult = {
  scannedLessons: number;
  remindersToSend: number;
  sentReminders: number;
  skippedLessons: number;
  dryRun: boolean;
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

function getReminderTarget(lesson: ReminderLesson): string | null {
  if (lesson.telegram_id?.trim()) {
    return lesson.telegram_id.trim();
  }

  if (lesson.telegram_username?.trim()) {
    return cleanUsername(lesson.telegram_username);
  }

  // This project does not yet have a safe id-to-entity resolution path.
  return null;
}

function formatLessonTime(startTime: string): string {
  const timeZone = process.env.APP_TIMEZONE ?? "Europe/Moscow";

  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(startTime));
}

function buildReminderMessage(lesson: ReminderLesson): string {
  const time = formatLessonTime(lesson.start_time);

  return `Привет, ${lesson.name_ru} 👋

Напоминаю: завтра у нас урок в ${time}.

Ответь, пожалуйста(цефрами):
1 — да, я готов
2 — нет, нужно отменить`;
}

export async function sendLessonReminders(): Promise<ReminderResult> {
  const now = Date.now();
  const lookaheadHours = getPositiveNumberEnv("REMINDER_LOOKAHEAD_HOURS", 24);
  const lookaheadUntil = now + lookaheadHours * 60 * 60 * 1000;
  const dryRun = isDryRun();

  if (!dryRun) {
    await resolveMissingTelegramIds();
  }

  const lessons = db
    .prepare(
      `
        SELECT
          lessons.id AS lesson_id,
          lessons.start_time,
          students.name_ru,
          students.telegram_username,
          students.telegram_id
        FROM lessons
        JOIN students ON students.id = lessons.student_id
        WHERE lessons.status = 'scheduled'
          AND lessons.reminder_sent = 0
      `
    )
    .all() as ReminderLesson[];

  const lessonsToSend: ReminderLesson[] = [];
  let skippedLessons = 0;

  for (const lesson of lessons) {
    const startTime = Date.parse(lesson.start_time);

    if (
      Number.isNaN(startTime) ||
      startTime <= now ||
      startTime > lookaheadUntil ||
      !getReminderTarget(lesson)
    ) {
      skippedLessons += 1;
      continue;
    }

    lessonsToSend.push(lesson);
  }

  const result: ReminderResult = {
    scannedLessons: lessons.length,
    remindersToSend: lessonsToSend.length,
    sentReminders: 0,
    skippedLessons,
    dryRun,
  };

  if (dryRun) {
    for (const lesson of lessonsToSend) {
      const target = getReminderTarget(lesson);
      console.log("Dry run reminder:");
      console.log({
        lessonId: lesson.lesson_id,
        target,
        message: buildReminderMessage(lesson),
      });
    }

    return result;
  }

  const updateReminderSent = db.prepare(
    `
      UPDATE lessons
      SET reminder_sent = 1,
          updated_at = datetime('now')
      WHERE id = ?
    `
  );

  const client = await getTelegramClient("reminderService", {
    sendOnly: true,
  });

  try {
    for (const lesson of lessonsToSend) {
      const target = getReminderTarget(lesson);

      if (!target) {
        result.skippedLessons += 1;
        continue;
      }

      await client.sendMessage(target, {
        message: buildReminderMessage(lesson),
      });

      updateReminderSent.run(lesson.lesson_id);
      result.sentReminders += 1;
    }
  } finally {
    await client.disconnect();
    console.log("reminderService Telegram client disconnected", {
      pid: process.pid,
    });
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
