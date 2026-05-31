import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.STUDENT_WELCOME_MESSAGE_ENABLED = "true";

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "telegram-assistant-welcome-test-")
);

process.chdir(tempDir);

const { db } = await import("../database/db");
const {
  buildStudentWelcomeMessage,
  sendStudentWelcomeMessage,
  setStudentWelcomeTelegramAdapterForTests,
} = await import("../services/studentWelcomeService");

const sentMessages: Array<{
  telegramId: string;
  telegramUsername: string | null;
  message: string;
}> = [];
let resolveCount = 0;

function insertStudent(input: {
  nameRu?: string;
  nameAr?: string;
  username?: string | null;
  telegramId?: string | null;
  welcomeSentAt?: string | null;
}): number {
  return Number(
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
            welcome_message_sent_at,
            is_active,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, 1000, 'RUB', ?, 1, datetime('now'))
        `
      )
      .run(
        input.nameRu ?? "",
        input.nameAr ?? "",
        input.username ?? null,
        input.telegramId ?? null,
        `student-${Date.now()}-${Math.random()}`,
        input.welcomeSentAt ?? null
      ).lastInsertRowid
  );
}

try {
  setStudentWelcomeTelegramAdapterForTests({
    async resolveTelegramId(username) {
      resolveCount += 1;
      return username === "@missing" ? null : "resolved-telegram-id";
    },
    async sendMessage(input) {
      sentMessages.push(input);
      return `welcome-${sentMessages.length}`;
    },
  });

  const directStudentId = insertStudent({
    nameRu: "Бараа",
    username: "@baraa",
    telegramId: "1001",
  });
  const directResult = await sendStudentWelcomeMessage(directStudentId);
  assert.equal(directResult.status, "sent");
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].message, /Привет, Бараа!/);

  const afterDirect = db
    .prepare(
      `
        SELECT welcome_message_sent_at, welcome_message_id
        FROM students
        WHERE id = ?
      `
    )
    .get(directStudentId) as {
    welcome_message_sent_at: string | null;
    welcome_message_id: string | null;
  };
  assert.ok(afterDirect.welcome_message_sent_at);
  assert.equal(afterDirect.welcome_message_id, "welcome-1");

  await sendStudentWelcomeMessage(directStudentId);
  assert.equal(sentMessages.length, 1);

  db.prepare(
    `
      UPDATE students
      SET name_ru = 'Edited Name'
      WHERE id = ?
    `
  ).run(directStudentId);
  assert.equal(sentMessages.length, 1);

  const resolveStudentId = insertStudent({
    nameRu: "طالب",
    username: "@needs_resolution",
  });
  const resolveResult = await sendStudentWelcomeMessage(resolveStudentId);
  assert.equal(resolveResult.status, "sent");
  assert.equal(resolveCount, 1);
  assert.equal(sentMessages.length, 2);
  const resolvedStudent = db
    .prepare("SELECT telegram_id FROM students WHERE id = ?")
    .get(resolveStudentId) as { telegram_id: string | null };
  assert.equal(resolvedStudent.telegram_id, "resolved-telegram-id");

  const missingStudentId = insertStudent({
    nameRu: "Missing",
    username: "@missing",
  });
  const missingResult = await sendStudentWelcomeMessage(missingStudentId);
  assert.equal(missingResult.status, "failed");
  assert.equal(sentMessages.length, 2);
  const missingStudent = db
    .prepare(
      `
        SELECT id, welcome_message_error
        FROM students
        WHERE id = ?
      `
    )
    .get(missingStudentId) as {
    id: number;
    welcome_message_error: string | null;
  };
  assert.equal(missingStudent.id, missingStudentId);
  assert.match(missingStudent.welcome_message_error ?? "", /Telegram ID/);

  const alreadySentStudentId = insertStudent({
    nameRu: "Already",
    username: "@already",
    telegramId: "1002",
    welcomeSentAt: new Date().toISOString(),
  });
  const alreadySentResult =
    await sendStudentWelcomeMessage(alreadySentStudentId);
  assert.equal(alreadySentResult.status, "skipped");
  assert.equal(sentMessages.length, 2);

  const manualResendStudentId = insertStudent({
    nameRu: "Manual",
    username: "@manual",
    telegramId: "1003",
  });
  const manualResult = await sendStudentWelcomeMessage(manualResendStudentId, {
    manual: true,
  });
  assert.equal(manualResult.status, "sent");
  assert.equal(sentMessages.length, 3);

  const fallbackMessage = buildStudentWelcomeMessage({
    id: 0,
    name_ru: "",
    name_ar: "",
    telegram_username: null,
    telegram_id: null,
    welcome_message_sent_at: null,
  });
  assert.match(fallbackMessage, /Привет, друг!/);

  console.log("Student welcome checks passed.");
} finally {
  setStudentWelcomeTelegramAdapterForTests(null);
  db.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}
