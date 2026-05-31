import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-idempotency-"));
process.chdir(tempDir);

const { db } = await import("../database/db");
const { createReceiptPaymentAndApply } = await import(
  "../services/paymentBalanceService"
);

type ReceiptInput = Parameters<typeof createReceiptPaymentAndApply>[0];

function receiptInput(
  studentId: number,
  telegramMessageId: string,
  amount: number,
  documentNumber = "M70272139777",
  receiptText = `Итого: ${amount} ₽\nСтатус: Успешно\nДокумент: ${documentNumber}`
): ReceiptInput {
  return {
    studentId,
    telegramMessageId,
    telegramFileId: `file-${telegramMessageId}`,
    receiptFilePath: `/tmp/${telegramMessageId}.pdf`,
    receiptText,
    aiResult: {
      is_payment_receipt: true,
      payment_confirmed: true,
      amount,
      currency: "RUB",
      payment_date: "2026-05-15",
      document_number: documentNumber,
      operation_id: null,
      recipient: "Teacher",
      sender: "Student",
      confidence: 0.95,
      reason: "test receipt",
    },
  };
}

function createStudent(keyword: string): number {
  const result = db
    .prepare(
      `
        INSERT INTO students (
          name_ru,
          name_ar,
          calendar_keyword,
          lesson_price_amount,
          lesson_price_currency
        )
        VALUES (?, ?, ?, 1000, 'RUB')
      `
    )
    .run(`Student ${keyword}`, `طالب ${keyword}`, keyword);

  return Number(result.lastInsertRowid);
}

function createCompletedLessonCharge(studentId: number): number {
  const lessonResult = db
    .prepare(
      `
        INSERT INTO lessons (
          google_event_id,
          student_id,
          title,
          start_time,
          end_time,
          status,
          updated_at
        )
        VALUES (?, ?, 'Lesson', datetime('now', '-1 hour'), datetime('now'), 'completed', datetime('now'))
      `
    )
    .run(`event-${studentId}-${Date.now()}-${Math.random()}`, studentId);

  const chargeResult = db
    .prepare(
      `
        INSERT INTO lesson_charges (lesson_id, student_id, amount, currency)
        VALUES (?, ?, 1000, 'RUB')
      `
    )
    .run(Number(lessonResult.lastInsertRowid), studentId);

  return Number(chargeResult.lastInsertRowid);
}

function paymentCountForTelegramMessage(telegramMessageId: string): number {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM payments
        WHERE telegram_message_id = ?
      `
    )
    .get(telegramMessageId) as { count: number };

  return row.count;
}

function allocationTotalForPayment(paymentId: number): number {
  const row = db
    .prepare(
      `
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM payment_allocations
        WHERE payment_id = ?
      `
    )
    .get(paymentId) as { total: number };

  return row.total;
}

function runConflictTest(): void {
  const studentId = createStudent("conflict");
  db.prepare(
    `
      INSERT INTO payments (
        student_id,
        status,
        amount,
        currency,
        telegram_message_id,
        payment_method
      )
      VALUES (?, 'confirmed', 300, 'RUB', '77207', 'receipt')
    `
  ).run(studentId);

  const result = createReceiptPaymentAndApply(receiptInput(studentId, "77207", 5000));

  assert.equal(result.conflict, true);
  assert.equal(result.duplicate, true);
  assert.match(result.conflictMessage ?? "", /existing 300 RUB, new 5000 RUB/);
  assert.equal(paymentCountForTelegramMessage("77207"), 1);
}

function runDuplicateMatchTest(): void {
  const studentId = createStudent("duplicate");
  const insertResult = db
    .prepare(
      `
        INSERT INTO payments (
          student_id,
          status,
          amount,
          currency,
          telegram_message_id,
          payment_method
        )
        VALUES (?, 'confirmed', 5000, 'RUB', '77208', 'receipt')
      `
    )
    .run(studentId);

  const result = createReceiptPaymentAndApply(receiptInput(studentId, "77208", 5000));

  assert.equal(result.conflict, false);
  assert.equal(result.duplicate, true);
  assert.equal(paymentCountForTelegramMessage("77208"), 1);
  assert.equal(allocationTotalForPayment(Number(insertResult.lastInsertRowid)), 0);
}

function runNewReceiptAllocationTest(): void {
  const studentId = createStudent("new-receipt");
  const chargeId = createCompletedLessonCharge(studentId);

  const result = createReceiptPaymentAndApply(receiptInput(studentId, "77209", 5000));

  assert.equal(result.conflict, false);
  assert.equal(result.duplicate, false);
  assert.equal(result.amount, 5000);
  assert.equal(result.allocatedAmount, 1000);
  assert.equal(result.prepaidAmount, 4000);
  assert.equal(paymentCountForTelegramMessage("77209"), 1);

  const allocation = db
    .prepare(
      `
        SELECT payment_id, lesson_charge_id, amount
        FROM payment_allocations
        WHERE payment_id = ?
      `
    )
    .get(result.paymentId) as
    | { payment_id: number; lesson_charge_id: number; amount: number }
    | undefined;

  assert.deepEqual(allocation, {
    payment_id: result.paymentId,
    lesson_charge_id: chargeId,
    amount: 1000,
  });
}

function runSameReceiptDifferentTelegramMessageTest(): void {
  const studentId = createStudent("same-file");
  const first = createReceiptPaymentAndApply(
    receiptInput(studentId, "77210", 5000, "M70272139777")
  );
  const second = createReceiptPaymentAndApply(
    receiptInput(studentId, "77211", 5000, "M70272139777")
  );
  const third = createReceiptPaymentAndApply(
    receiptInput(studentId, "77212", 5000, "M70272139777")
  );

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.duplicateReason, "receipt_fingerprint");
  assert.equal(third.duplicate, true);

  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS payment_count, COALESCE(SUM(amount), 0) AS total
        FROM payments
        WHERE student_id = ?
      `
    )
    .get(studentId) as { payment_count: number; total: number };

  assert.equal(row.payment_count, 1);
  assert.equal(row.total, 5000);
}

function runDocumentNumberConflictTest(): void {
  const studentId = createStudent("document-conflict");
  const first = createReceiptPaymentAndApply(
    receiptInput(studentId, "77213", 300, "M70272139778")
  );
  const second = createReceiptPaymentAndApply(
    receiptInput(studentId, "77214", 5000, "M70272139778")
  );

  assert.equal(first.duplicate, false);
  assert.equal(second.conflict, true);
  assert.equal(second.duplicateReason, "document_number");
  assert.match(second.conflictMessage ?? "", /existing 300 RUB, new 5000 RUB/);
}

try {
  runConflictTest();
  runDuplicateMatchTest();
  runNewReceiptAllocationTest();
  runSameReceiptDifferentTelegramMessageTest();
  runDocumentNumberConflictTest();
  console.log("receipt idempotency tests passed");
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
