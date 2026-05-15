import path from "node:path";
import { fileURLToPath } from "node:url";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { db } from "../database/db";
import { getTelegramClient } from "./telegramClient";

const recentLessonWindowHours = 4;
const cancellationDeadlineHours = Number(
  process.env.CANCELLATION_DEADLINE_HOURS ?? 10
);

type Student = {
  id: number;
  telegram_id: string;
};

type Lesson = {
  id: number;
  start_time: string;
  status: string;
  student_response: string | null;
};

function findNearestRemindedLesson(studentId: number): Lesson | null {
  const now = Date.now();
  const recentCutoff = now - recentLessonWindowHours * 60 * 60 * 1000;

  const lessons = db
    .prepare(
      `
        SELECT id, start_time, status, student_response
        FROM lessons
        WHERE student_id = ?
          AND reminder_sent = 1
          AND status IN (
            'scheduled',
            'confirmed',
            'cancelled_by_student',
            'cancelled_by_teacher'
          )
      `
    )
    .all(studentId) as Lesson[];

  const activeLessons = lessons
    .map((lesson) => ({
      lesson,
      startTimeMs: Date.parse(lesson.start_time),
    }))
    .filter(
      ({ startTimeMs }) =>
        !Number.isNaN(startTimeMs) && startTimeMs >= recentCutoff
    )
    .sort(
      (left, right) =>
        Math.abs(left.startTimeMs - now) - Math.abs(right.startTimeMs - now)
    );

  return activeLessons[0]?.lesson ?? null;
}

function saveTelegramMessage(
  studentId: number,
  chatId: string,
  messageId: string,
  text: string,
  sentAt: string
): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO telegram_messages (
        student_id,
        telegram_chat_id,
        telegram_message_id,
        sender,
        text,
        sent_at,
        created_at
      )
      VALUES (?, ?, ?, 'student', ?, ?, datetime('now'))
    `
  ).run(studentId, chatId, messageId, text, sentAt);
}

async function handleIncomingMessage(event: NewMessageEvent): Promise<void> {
  const message = event.message;

  if (message.out) {
    return;
  }

  const sender = await message.getSender();
  const senderTelegramId = message.senderId?.toString();
  const text = (message.message ?? "").trim();
  const chatId = message.chatId?.toString();

  if (!sender || !senderTelegramId || !chatId) {
    return;
  }

  if (text !== "1" && text !== "2") {
    console.log("Ignored non-command message.");
    return;
  }

  const student = db
    .prepare(
      `
        SELECT id, telegram_id
        FROM students
        WHERE telegram_id = ?
      `
    )
    .get(senderTelegramId) as Student | undefined;

  if (!student) {
    return;
  }

  const lesson = findNearestRemindedLesson(student.id);

  if (!lesson) {
    return;
  }

  if (text === "1") {
    if (
      lesson.status === "confirmed" &&
      lesson.student_response === "ready"
    ) {
      console.log(`Ignored duplicate ready response for lesson ${lesson.id}`);
      return;
    }

    if (
      lesson.status === "cancelled_by_student" ||
      lesson.status === "cancelled_by_teacher"
    ) {
      saveTelegramMessage(
        student.id,
        chatId,
        message.id.toString(),
        text,
        new Date(message.date * 1000).toISOString()
      );

      await message.respond({
        message:
          "Урок уже отмечен как отменённый. Если нужно восстановить урок, напиши преподавателю напрямую.",
      });

      console.log(`Cancelled lesson ${lesson.id} kept unchanged after ready reply`);
      return;
    }

    db.prepare(
      `
        UPDATE lessons
        SET status = 'confirmed',
            student_response = 'ready',
            student_response_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(lesson.id);

    saveTelegramMessage(
      student.id,
      chatId,
      message.id.toString(),
      text,
      new Date(message.date * 1000).toISOString()
    );

    await message.respond({
      message: "Отлично, до встречи на уроке ✅",
    });

    console.log(`Lesson ${lesson.id} confirmed`);
    return;
  }

  if (
    lesson.status === "cancelled_by_student" ||
    lesson.status === "cancelled_by_teacher"
  ) {
    return;
  }

  const lessonStartTime = Date.parse(lesson.start_time);
  const hoursUntilLesson = (lessonStartTime - Date.now()) / (60 * 60 * 1000);

  saveTelegramMessage(
    student.id,
    chatId,
    message.id.toString(),
    text,
    new Date(message.date * 1000).toISOString()
  );

  if (hoursUntilLesson <= cancellationDeadlineHours) {
    await message.respond({
      message:
        "Извини, я не могу отменить урок менее чем за 10 часов до начала. Напиши преподавателю напрямую.",
    });

    console.log(`Cancellation rejected because deadline passed for lesson ${lesson.id}`);
    return;
  }

  db.prepare(
    `
      UPDATE lessons
      SET status = 'cancelled_by_student',
          student_response = 'not_ready',
          student_response_at = datetime('now'),
          cancellation_source = 'student',
          updated_at = datetime('now')
      WHERE id = ?
    `
  ).run(lesson.id);

  await message.respond({
    message: "Понял, отмену урока зафиксировал.",
  });

  console.log(`Lesson ${lesson.id} cancelled`);
}

export async function startTelegramListener(): Promise<void> {
  const client = await getTelegramClient();

  client.addEventHandler(
    (event) => {
      void handleIncomingMessage(event).catch((error) => {
        console.error("Failed to handle Telegram message:");
        console.error(error);
      });
    },
    new NewMessage({ incoming: true })
  );

  console.log("Telegram listener started.");
  await new Promise<void>(() => undefined);
}

async function main() {
  try {
    await startTelegramListener();
  } catch (error) {
    console.error("Telegram listener failed:");
    console.error(error);
    process.exit(1);
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (currentFilePath === executedFilePath) {
  void main();
}
