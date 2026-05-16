import { Api, TelegramClient } from "telegram";
import { db } from "../database/db";
import { getTelegramClient } from "./telegramClient";

type StudentIdentity = {
  id: number;
  telegram_username: string;
};

function cleanUsername(username: string): string {
  return username.trim().replace(/^@/, "");
}

async function resolveStudentWithClient(
  student: StudentIdentity,
  client: TelegramClient
): Promise<void> {
  try {
    const entity = await client.getEntity(cleanUsername(student.telegram_username));
    const telegramId =
      entity instanceof Api.User && entity.id ? entity.id.toString() : null;

    if (!telegramId) {
      console.error("Telegram ID resolve returned no user id", {
        studentId: student.id,
        username: student.telegram_username,
      });
      return;
    }

    db.prepare("UPDATE students SET telegram_id = ? WHERE id = ?").run(
      telegramId,
      student.id
    );

    console.log("Resolved student telegram_id", {
      studentId: student.id,
      username: student.telegram_username,
      telegram_id: telegramId,
    });
  } catch (error) {
    console.error("Failed to resolve student telegram_id", {
      studentId: student.id,
      username: student.telegram_username,
      error: error instanceof Error ? error.message : "unknown error",
    });
  }
}

export async function resolveAndSaveTelegramIdForStudent(
  studentId: number
): Promise<void> {
  const student = db
    .prepare(
      `
        SELECT id, telegram_username
        FROM students
        WHERE id = ?
          AND is_active = 1
          AND telegram_username IS NOT NULL
          AND telegram_username != ''
          AND (telegram_id IS NULL OR telegram_id = '')
      `
    )
    .get(studentId) as StudentIdentity | undefined;

  if (!student) {
    return;
  }

  const client = await getTelegramClient("telegramIdentityService", {
    sendOnly: true,
  });

  try {
    await resolveStudentWithClient(student, client);
  } finally {
    await client.disconnect();
    console.log("telegramIdentityService Telegram client disconnected", {
      pid: process.pid,
    });
  }
}

export async function resolveMissingTelegramIds(): Promise<void> {
  const students = db
    .prepare(
      `
        SELECT id, telegram_username
        FROM students
        WHERE is_active = 1
          AND telegram_username IS NOT NULL
          AND telegram_username != ''
          AND (telegram_id IS NULL OR telegram_id = '')
        ORDER BY id
      `
    )
    .all() as StudentIdentity[];

  if (students.length === 0) {
    console.log("No missing Telegram IDs to resolve.");
    return;
  }

  const client = await getTelegramClient("telegramIdentityService", {
    sendOnly: true,
  });

  try {
    for (const student of students) {
      await resolveStudentWithClient(student, client);
    }
  } finally {
    await client.disconnect();
    console.log("telegramIdentityService Telegram client disconnected", {
      pid: process.pid,
    });
  }
}
