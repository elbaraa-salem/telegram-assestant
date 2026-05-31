import "dotenv/config";
import { Api } from "telegram";
import { db } from "../database/db";

type StudentWelcomeRow = {
  id: number;
  name_ru: string | null;
  name_ar: string | null;
  telegram_username: string | null;
  telegram_id: string | null;
  welcome_message_sent_at: string | null;
};

export type StudentWelcomeResult =
  | { status: "sent"; messageId: string | null }
  | { status: "skipped"; reason: "disabled" | "already_sent" | "not_found" }
  | { status: "failed"; error: string };

type StudentWelcomeTelegramAdapter = {
  resolveTelegramId(username: string): Promise<string | null>;
  sendMessage(input: {
    telegramId: string;
    telegramUsername: string | null;
    message: string;
  }): Promise<string | null>;
};

let telegramAdapterOverride: StudentWelcomeTelegramAdapter | null = null;

export function setStudentWelcomeTelegramAdapterForTests(
  adapter: StudentWelcomeTelegramAdapter | null
): void {
  telegramAdapterOverride = adapter;
}

function welcomeMessagesEnabled(): boolean {
  return (
    String(process.env.STUDENT_WELCOME_MESSAGE_ENABLED ?? "true")
      .trim()
      .toLowerCase() === "true"
  );
}

function cleanUsername(username: string): string {
  return username.trim().replace(/^@/, "");
}

function getStudentDisplayName(student: StudentWelcomeRow): string {
  return (
    student.name_ru?.trim() ||
    student.name_ar?.trim() ||
    student.telegram_username?.trim() ||
    "друг"
  );
}

export function buildStudentWelcomeMessage(student: StudentWelcomeRow): string {
  const studentName = getStudentDisplayName(student);

  return `Привет, ${studentName}! 👋

Я личный помощник Бараа.

Я буду помогать тебе с напоминаниями об уроках и с оплатой, чтобы ничего не перепуталось и не забылось.

Я автоматический помощник, и Бараа сейчас меня развивает. Если ты заметишь ошибку, мы будем очень благодарны за помощь.

В будущем у меня появится больше возможностей, а пока это первая версия.

Удачи в изучении арабского языка! 🌿`;
}

function getStudent(studentId: number): StudentWelcomeRow | undefined {
  return db
    .prepare(
      `
        SELECT
          id,
          name_ru,
          name_ar,
          telegram_username,
          telegram_id,
          welcome_message_sent_at
        FROM students
        WHERE id = ?
      `
    )
    .get(studentId) as StudentWelcomeRow | undefined;
}

async function resolveTelegramIdWithClient(username: string): Promise<string | null> {
  if (telegramAdapterOverride) {
    return telegramAdapterOverride.resolveTelegramId(username);
  }

  const { getTelegramClient } = await import("./telegramClient");
  const client = await getTelegramClient("studentWelcomeService", {
    sendOnly: true,
  });

  try {
    const entity = await client.getEntity(cleanUsername(username));
    return entity instanceof Api.User && entity.id ? entity.id.toString() : null;
  } finally {
    await client.disconnect();
    console.log("studentWelcomeService Telegram resolver disconnected", {
      pid: process.pid,
    });
  }
}

async function sendWelcomeMessage(input: {
  telegramId: string;
  telegramUsername: string | null;
  message: string;
}): Promise<string | null> {
  if (telegramAdapterOverride) {
    return telegramAdapterOverride.sendMessage(input);
  }

  const { getTelegramClient } = await import("./telegramClient");
  const client = await getTelegramClient("studentWelcomeService", {
    sendOnly: true,
  });

  try {
    const target = input.telegramUsername
      ? cleanUsername(input.telegramUsername)
      : input.telegramId;
    const sentMessage = (await client.sendMessage(target, {
      message: input.message,
    })) as { id?: unknown } | undefined;

    return sentMessage?.id === undefined ? null : String(sentMessage.id);
  } finally {
    await client.disconnect();
    console.log("studentWelcomeService Telegram sender disconnected", {
      pid: process.pid,
    });
  }
}

function saveWelcomeError(studentId: number, error: string): void {
  db.prepare(
    `
      UPDATE students
      SET welcome_message_error = ?
      WHERE id = ?
    `
  ).run(error, studentId);
}

export async function sendStudentWelcomeMessage(
  studentId: number,
  options: { manual?: boolean } = {}
): Promise<StudentWelcomeResult> {
  if (!options.manual && !welcomeMessagesEnabled()) {
    return { status: "skipped", reason: "disabled" };
  }

  console.log("welcome message sending started", { studentId });

  const student = getStudent(studentId);

  if (!student) {
    return { status: "skipped", reason: "not_found" };
  }

  if (student.welcome_message_sent_at) {
    console.log("welcome message skipped because already sent", {
      studentId,
      welcomeMessageSentAt: student.welcome_message_sent_at,
    });
    return { status: "skipped", reason: "already_sent" };
  }

  try {
    let telegramId = student.telegram_id?.trim() || null;

    if (!telegramId && student.telegram_username) {
      telegramId = await resolveTelegramIdWithClient(student.telegram_username);

      if (telegramId) {
        db.prepare("UPDATE students SET telegram_id = ? WHERE id = ?").run(
          telegramId,
          studentId
        );
        console.log("telegram id resolution result", {
          studentId,
          telegramId,
          resolved: true,
        });
      }
    }

    if (!telegramId) {
      const error =
        "Telegram ID could not be resolved, so welcome message was not sent.";
      saveWelcomeError(studentId, error);
      console.log("telegram id resolution result", {
        studentId,
        telegramId: null,
        resolved: false,
      });
      console.error("welcome message failed", { studentId, error });
      return { status: "failed", error };
    }

    const messageId = await sendWelcomeMessage({
      telegramId,
      telegramUsername: student.telegram_username,
      message: buildStudentWelcomeMessage({ ...student, telegram_id: telegramId }),
    });

    db.prepare(
      `
        UPDATE students
        SET welcome_message_sent_at = datetime('now'),
            welcome_message_id = ?,
            welcome_message_error = NULL
        WHERE id = ?
          AND welcome_message_sent_at IS NULL
      `
    ).run(messageId, studentId);

    console.log("welcome message sent", {
      studentId,
      messageId,
    });

    return { status: "sent", messageId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    saveWelcomeError(studentId, errorMessage);
    console.error("welcome message failed", {
      studentId,
      error: errorMessage,
    });
    return { status: "failed", error: errorMessage };
  }
}
