import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLocalReceiptText } from "../services/localReceiptParser";
import { ReceiptAiResult } from "../services/receiptAnalysisService";

function assertSuccessfulReceipt(text: string, amount: number): void {
  const result = parseLocalReceiptText(text);

  assert.equal(result.isPaymentReceipt, true);
  assert.equal(result.amount, amount);
  assert.equal(result.currency, "RUB");
  assert.equal(result.status, "success");
  assert.equal(result.confidence >= 0.9, true);
}

function runSberReceiptTest(): void {
  const result = parseLocalReceiptText(`
    СберБанк Онлайн
    Чек по операции
    Перевод выполнен
    Сумма перевода 1 500,00 ₽
    Дата 01.06.2026
    Получатель Иван Иванов
  `);

  assert.equal(result.isPaymentReceipt, true);
  assert.equal(result.amount, 1500);
  assert.equal(result.currency, "RUB");
  assert.equal(result.status, "success");
  assert.equal(result.date, "2026-06-01");
  assert.equal(result.confidence >= 0.9, true);
}

function runVtbReceiptTest(): void {
  assertSuccessfulReceipt(
    `
      ВТБ
      Квитанция
      Операция выполнена
      Сумма операции: 1500 RUB
      01/06/2026
    `,
    1500
  );
}

function runTBankReceiptTest(): void {
  const result = parseLocalReceiptText(`
    T-Bank
    Чек
    Выполнено
    Итого 1,500.00 RUB
    2026-06-01
  `);

  assert.equal(result.amount, 1500);
  assert.equal(result.status, "success");
  assert.equal(result.date, "2026-06-01");
}

function runAmountFormatTests(): void {
  assert.equal(parseLocalReceiptText("Чек Успешно Сумма 1 500,00 ₽").amount, 1500);
  assert.equal(parseLocalReceiptText("Квитанция Успешно Сумма операции 1500 RUB").amount, 1500);
}

function runStatusTests(): void {
  assert.equal(parseLocalReceiptText("Чек Перевод выполнен Сумма 1500 RUB").status, "success");
  assert.equal(parseLocalReceiptText("Чек Не выполнено Сумма 1500 RUB").status, "failed");
}

function runStudyMaterialIgnoredTest(): void {
  const result = parseLocalReceiptText(`
    Учебник
    Урок 5
    Упражнение 3
    listening audio
    страница 42
  `);

  assert.equal(result.isPaymentReceipt, false);
  assert.equal(result.confidence >= 0.9, true);
  assert.equal(result.reason, "Looks like study material, not a payment receipt");
}

function runUnclearPdfFallsBackToAiTest(): void {
  const result = parseLocalReceiptText("Some arbitrary PDF text without receipt data.");

  assert.equal(result.isPaymentReceipt, false);
  assert.equal(result.confidence < 0.6, true);
}

async function runLocalParserAllocationTest(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-receipt-parser-"));
  const originalCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const { db } = await import("../database/db");
    const { createReceiptPaymentAndApply } = await import(
      "../services/paymentBalanceService"
    );

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
          VALUES ('Student local', 'طالب local', 'local-parser', 1000, 'RUB')
        `
      )
      .run();
    const studentId = Number(studentResult.lastInsertRowid);
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
          VALUES ('local-parser-event', ?, 'Lesson', datetime('now', '-1 hour'), datetime('now'), 'completed', datetime('now'))
        `
      )
      .run(studentId);
    const chargeResult = db
      .prepare(
        `
          INSERT INTO lesson_charges (lesson_id, student_id, amount, currency)
          VALUES (?, ?, 1000, 'RUB')
        `
      )
      .run(Number(lessonResult.lastInsertRowid), studentId);

    const receiptText = "Чек Перевод выполнен Сумма перевода 1 500,00 ₽ 02 июня 2026";
    const parsed = parseLocalReceiptText(receiptText);
    const aiResult: ReceiptAiResult = {
      is_payment_receipt: parsed.isPaymentReceipt,
      payment_confirmed: parsed.status === "success",
      amount: parsed.amount,
      currency: parsed.currency,
      payment_date: parsed.date,
      document_number: null,
      operation_id: null,
      recipient: null,
      sender: null,
      confidence: parsed.confidence,
      reason: parsed.reason,
    };

    const result = createReceiptPaymentAndApply({
      studentId,
      telegramMessageId: "local-parser-message",
      telegramFileId: "local-parser-file",
      receiptFilePath: "/tmp/local-parser.pdf",
      receiptText,
      aiResult,
      parserSource: "local",
    });

    assert.equal(result.duplicate, false);
    assert.equal(result.amount, 1500);
    assert.equal(result.allocatedAmount, 1000);
    assert.equal(result.prepaidAmount, 500);

    const payment = db
      .prepare(
        `
          SELECT ai_parser_source
          FROM payments
          WHERE id = ?
        `
      )
      .get(result.paymentId) as { ai_parser_source: string | null };
    assert.equal(payment.ai_parser_source, "local");

    const allocation = db
      .prepare(
        `
          SELECT lesson_charge_id, amount
          FROM payment_allocations
          WHERE payment_id = ?
        `
      )
      .get(result.paymentId) as { lesson_charge_id: number; amount: number };
    assert.deepEqual(allocation, {
      lesson_charge_id: Number(chargeResult.lastInsertRowid),
      amount: 1000,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    db.close();
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runSberReceiptTest();
runVtbReceiptTest();
runTBankReceiptTest();
runAmountFormatTests();
runStatusTests();
runStudyMaterialIgnoredTest();
runUnclearPdfFallsBackToAiTest();
await runLocalParserAllocationTest();

console.log("local receipt parser tests passed");
