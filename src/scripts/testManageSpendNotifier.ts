import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.MANAGE_SPEND_BOT_NOTIFICATIONS_ENABLED = "true";
process.env.MANAGE_SPEND_BOT_USERNAME = "@ManageSpendBot";

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "telegram-assistant-manage-spend-test-")
);

process.chdir(tempDir);

const { db } = await import("../database/db");
const {
  notifyManageSpendBotForPayment,
  setManageSpendTelegramSenderForTests,
} = await import("../services/manageSpendBotNotifier");
const { createManualPaymentAndApply, createReceiptPaymentAndApply } = await import(
  "../services/paymentBalanceService"
);

type SentMessage = {
  username: string;
  message: string;
};

const sentMessages: SentMessage[] = [];
let studentSequence = 0;

setManageSpendTelegramSenderForTests(async (username, message) => {
  sentMessages.push({ username, message });
  return String(sentMessages.length);
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForSentMessages(count: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 2_000) {
    if (sentMessages.length >= count) {
      return;
    }

    await wait(25);
  }

  throw new Error(`expected ${count} manage spend messages, got ${sentMessages.length}`);
}

function insertStudent(nameRu: string, priceAmount: number): number {
  studentSequence += 1;

  return Number(
    db
      .prepare(
        `
          INSERT INTO students (
            name_ru,
            name_ar,
            calendar_keyword,
            lesson_price_amount,
            lesson_price_currency,
            is_active,
            created_at
          )
          VALUES (?, 'طالب', ?, ?, 'RUB', 1, datetime('now'))
        `
      )
      .run(
        nameRu,
        `student-${studentSequence}-${nameRu}-${priceAmount}`,
        priceAmount
      )
      .lastInsertRowid
  );
}

function insertPayment(studentId: number, amount: number): number {
  return Number(
    db
      .prepare(
        `
          INSERT INTO payments (
            student_id,
            status,
            amount,
            currency,
            paid_at,
            payment_method,
            updated_at
          )
          VALUES (?, 'confirmed', ?, 'RUB', datetime('now'), 'manual', datetime('now'))
        `
      )
      .run(studentId, amount).lastInsertRowid
  );
}

try {
  const oneLessonStudentId = insertStudent("Бараа", 1000);
  const twoLessonStudentId = insertStudent("Бараа", 1000);
  const fiveLessonStudentId = insertStudent("Бараа", 1000);
  const partialStudentId = insertStudent("Бараа", 1000);

  await notifyManageSpendBotForPayment(insertPayment(oneLessonStudentId, 1000));
  await notifyManageSpendBotForPayment(insertPayment(twoLessonStudentId, 2000));
  await notifyManageSpendBotForPayment(insertPayment(fiveLessonStudentId, 5000));
  await notifyManageSpendBotForPayment(insertPayment(partialStudentId, 1500));

  assert.deepEqual(
    sentMessages.map((message) => message.message),
    [
      "получил 1000 RUB за занятие с Бараа",
      "получил 2000 RUB за 2 занятия с Бараа",
      "получил 5000 RUB за 5 занятий с Бараа",
      "получил 1500 RUB за занятия с Бараа",
    ]
  );
  assert.ok(
    sentMessages.every((message) => message.username === "@ManageSpendBot")
  );

  const idempotentPaymentId = insertPayment(oneLessonStudentId, 1000);
  await notifyManageSpendBotForPayment(idempotentPaymentId);
  await notifyManageSpendBotForPayment(idempotentPaymentId);
  assert.equal(sentMessages.length, 5);

  const receiptStudentId = insertStudent("Бараа", 1000);
  createReceiptPaymentAndApply({
    studentId: receiptStudentId,
    telegramMessageId: "receipt-duplicate-message-1",
    telegramFileId: "file-1",
    receiptFilePath: "/tmp/receipt-1.pdf",
    receiptText: "receipt duplicate text",
    aiResult: {
      is_payment_receipt: true,
      payment_confirmed: true,
      amount: 1000,
      currency: "RUB",
      payment_date: "2026-06-01",
      confidence: 0.99,
      reason: "test",
      sender: "student",
      recipient: "teacher",
      document_number: "DOC-1",
      operation_id: "OP-1",
    },
  });
  await waitForSentMessages(6);
  createReceiptPaymentAndApply({
    studentId: receiptStudentId,
    telegramMessageId: "receipt-duplicate-message-2",
    telegramFileId: "file-2",
    receiptFilePath: "/tmp/receipt-2.pdf",
    receiptText: "receipt duplicate text",
    aiResult: {
      is_payment_receipt: true,
      payment_confirmed: true,
      amount: 1000,
      currency: "RUB",
      payment_date: "2026-06-01",
      confidence: 0.99,
      reason: "test",
      sender: "student",
      recipient: "teacher",
      document_number: "DOC-1",
      operation_id: "OP-1",
    },
  });
  await wait(100);
  assert.equal(sentMessages.length, 6);

  setManageSpendTelegramSenderForTests(async () => {
    throw new Error("ManageSpendBot unavailable");
  });
  const failureStudentId = insertStudent("Бараа", 1000);
  const failureResult = createManualPaymentAndApply(failureStudentId, 1000, "RUB");
  await wait(100);
  const failedPayment = db
    .prepare(
      `
        SELECT status, manage_spend_notified_at, manage_spend_notify_error
        FROM payments
        WHERE id = ?
      `
    )
    .get(failureResult.paymentId) as {
    status: string;
    manage_spend_notified_at: string | null;
    manage_spend_notify_error: string | null;
  };
  assert.equal(failedPayment.status, "confirmed");
  assert.equal(failedPayment.manage_spend_notified_at, null);
  assert.match(
    failedPayment.manage_spend_notify_error ?? "",
    /ManageSpendBot unavailable/
  );

  console.log("ManageSpendBot notifier checks passed.");
} finally {
  setManageSpendTelegramSenderForTests(null);
  db.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}
