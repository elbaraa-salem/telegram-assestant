import path from "node:path";
import { fileURLToPath } from "node:url";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { db } from "../database/db";
import { getTelegramClient } from "./telegramClient";

const recentLessonWindowHours = 4;

type Student = {
  id: number;
  telegram_id: string;
};

type ActiveLesson = {
  id: number;
  start_time: string;
};

function findNearestActiveLesson(studentId: number): ActiveLesson | null {
  const now = Date.now();
  const recentCutoff = now - recentLessonWindowHours * 60 * 60 * 1000;

  const lessons = db
    .prepare(
      `
        SELECT id, start_time
        FROM lessons
        WHERE student_id = ?
          AND reminder_sent = 1
          AND status IN ('scheduled', 'confirmed')
      `
    )
    .all(studentId) as ActiveLesson[];

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

async function handleIncomingMessage(event: NewMessageEvent): Promise<void> {
  const message = event.message;

  if (message.out) {
    return;
  }

  const sender = await message.getSender();
  const senderTelegramId = message.senderId?.toString();
  const text = message.message ?? "";
  const chatId = message.chatId?.toString();

  if (!sender || !senderTelegramId || !chatId) {
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
    console.log(`No matching student for Telegram user ${senderTelegramId}`);
    return;
  }

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
  ).run(
    student.id,
    chatId,
    message.id.toString(),
    text,
    new Date(message.date * 1000).toISOString()
  );

  console.log(`Message saved for student ${student.id}`);

  if (text !== "1" && text !== "2") {
    return;
  }

  const lesson = findNearestActiveLesson(student.id);

  if (!lesson) {
    console.log(`No active reminded lesson for student ${student.id}`);
    return;
  }

  if (text === "1") {
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

    await message.respond({
      message: "Отлично, до встречи на уроке ✅",
    });

    console.log(`Lesson ${lesson.id} updated: ready`);
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

  console.log(`Lesson ${lesson.id} updated: not_ready`);
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
