import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-ai-db-"));
process.chdir(tempDir);

const { db } = await import("../database/db");
const { saveReceiptPaymentForManualReview } = await import(
  "../services/paymentBalanceService"
);

try {
  const studentResult = db
    .prepare(
      `
        INSERT INTO students (
          name_ru,
          name_ar,
          calendar_keyword,
          lesson_price_amount,
          lesson_price_currency
        )
        VALUES ('Student ai db', 'طالب ai db', 'receipt-ai-db', 1000, 'RUB')
      `
    )
    .run();
  const studentId = Number(studentResult.lastInsertRowid);

  const result = saveReceiptPaymentForManualReview({
    studentId,
    telegramMessageId: "receipt-ai-db-message",
    telegramFileId: "receipt-ai-db-file",
    receiptFilePath: "/tmp/receipt-ai-db.pdf",
    receiptText: "Чек Сумма 1500 RUB Статус неизвестен",
    parserSource: "ai",
    aiResult: {
      is_payment_receipt: true,
      payment_confirmed: null,
      amount: 1500,
      currency: "RUB",
      payment_date: "2026-06-01",
      document_number: null,
      operation_id: null,
      recipient: null,
      sender: null,
      confidence: 0.7,
      reason: "test pending review",
    },
  });

  assert.equal(result.duplicate, false);

  const payment = db
    .prepare(
      `
        SELECT
          status,
          amount,
          currency,
          ai_amount,
          ai_currency,
          ai_payment_date,
          ai_confidence,
          ai_parser_source,
          ai_raw_result
        FROM payments
        WHERE id = ?
      `
    )
    .get(result.paymentId) as {
    status: string;
    amount: number | null;
    currency: string | null;
    ai_amount: number | null;
    ai_currency: string | null;
    ai_payment_date: string | null;
    ai_confidence: number | null;
    ai_parser_source: string | null;
    ai_raw_result: string | null;
  };

  assert.equal(payment.status, "pending_manual_review");
  assert.equal(payment.amount, 1500);
  assert.equal(payment.currency, "RUB");
  assert.equal(payment.ai_amount, 1500);
  assert.equal(payment.ai_currency, "RUB");
  assert.equal(payment.ai_payment_date, "2026-06-01");
  assert.equal(payment.ai_confidence, 0.7);
  assert.equal(payment.ai_parser_source, "ai");
  assert.equal(JSON.parse(payment.ai_raw_result ?? "{}").reason, "test pending review");

  const duplicate = saveReceiptPaymentForManualReview({
    studentId,
    telegramMessageId: "receipt-ai-db-message",
    telegramFileId: "receipt-ai-db-file-2",
    receiptFilePath: "/tmp/receipt-ai-db-2.pdf",
    receiptText: "duplicate",
    parserSource: "ai",
    aiResult: {
      is_payment_receipt: true,
      payment_confirmed: null,
      amount: 1500,
      currency: "RUB",
      payment_date: "2026-06-01",
      document_number: null,
      operation_id: null,
      recipient: null,
      sender: null,
      confidence: 0.7,
      reason: "duplicate",
    },
  });

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.paymentId, result.paymentId);

  console.log("receipt AI DB tests passed");
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
