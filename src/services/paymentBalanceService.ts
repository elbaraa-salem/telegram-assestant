import crypto from "node:crypto";
import { db } from "../database/db";
import { notifyManageSpendBotForPayment } from "./manageSpendBotNotifier";
import { ReceiptAiResult } from "./receiptAnalysisService";

type LessonCharge = {
  id: number;
  lesson_id: number | null;
  student_id: number;
  charge_type: "lesson" | "manual";
  amount: number;
  currency: string;
  status: "unpaid" | "partial" | "paid";
  paid_amount: number;
  note: string | null;
};

type PaymentRow = {
  id: number;
  student_id: number;
  amount: number | null;
  currency: string;
  status: string;
  receipt_fingerprint?: string | null;
  receipt_document_number?: string | null;
  receipt_operation_id?: string | null;
};

type LessonForCharge = {
  id: number;
  status: string;
  student_id: number;
  lesson_price_amount: number;
  lesson_price_currency: string;
};

export type StudentBalanceSummary = {
  unpaid_lessons_count: number;
  unpaid_amount: number;
  prepaid_amount: number;
  prepaid_lessons_count: number;
  currency: string;
};

export type PaymentApplicationResult = {
  paymentId: number;
  studentId: number;
  amount: number;
  currency: string;
  lessonPriceAmount: number;
  allocatedAmount: number;
  paidLessonsCount: number;
  remainingDebtAmount: number;
  prepaidAmount: number;
  prepaidLessonsCount: number;
  duplicate: boolean;
  conflict: boolean;
  conflictMessage?: string;
  duplicateReason?: "telegram_message_id" | "receipt_fingerprint" | "document_number" | "operation_id";
  confirmationMessageSent: boolean;
};

export type CreateReceiptPaymentInput = {
  studentId: number;
  telegramMessageRowId?: number;
  telegramMessageId: string;
  telegramFileId: string;
  receiptFilePath: string;
  receiptText: string;
  aiResult: ReceiptAiResult;
  parserSource?: "local" | "ai";
};

export type SaveReceiptForManualReviewInput = CreateReceiptPaymentInput;

function normalizeAmount(value: number | null | undefined): number {
  return Number.isFinite(value) && value ? Math.max(0, Math.round(value)) : 0;
}

function notifyManageSpendAfterCommit(result: PaymentApplicationResult): void {
  if (result.duplicate || result.conflict || result.paymentId <= 0) {
    return;
  }

  void notifyManageSpendBotForPayment(result.paymentId);
}

function normalizeReceiptIdentityValue(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase().replace(/\s+/g, "") ?? "";
  return normalized || null;
}

function normalizeReceiptCurrency(value: string | null | undefined): string {
  return (value?.trim().toUpperCase() || "RUB").replace("₽", "RUB");
}

function normalizeReceiptDate(value: string | null | undefined): string {
  return value?.trim() || "";
}

function generateReceiptFingerprint(input: {
  studentId: number;
  amount: number;
  currency: string;
  paymentDate: string | null;
  documentNumber: string | null;
  operationId: string | null;
  sender: string | null;
  recipient: string | null;
  receiptText: string;
}): string {
  const normalizedReceiptText = input.receiptText
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  const receiptTextHash = crypto
    .createHash("sha256")
    .update(normalizedReceiptText)
    .digest("hex");
  const strongIdentifier =
    input.documentNumber ??
    input.operationId ??
    [
      normalizeReceiptDate(input.paymentDate),
      normalizeReceiptIdentityValue(input.sender),
      normalizeReceiptIdentityValue(input.recipient),
      receiptTextHash,
    ].join(":");
  const payload = [
    input.studentId,
    strongIdentifier,
    input.amount,
    input.currency,
    normalizeReceiptDate(input.paymentDate),
  ].join("|");

  return crypto.createHash("sha256").update(payload).digest("hex");
}

function markTelegramMessageProcessedIfNeeded(
  rowId: number | undefined,
  studentId: number
): void {
  if (!rowId) {
    return;
  }

  db.prepare(
    `
      UPDATE telegram_messages
      SET student_id = ?,
          processed_at = datetime('now'),
          processing_status = 'processed',
          error = NULL
      WHERE id = ?
    `
  ).run(studentId, rowId);
}

function markTelegramMessageConflictIfNeeded(
  rowId: number | undefined,
  studentId: number,
  message: string
): void {
  if (!rowId) {
    return;
  }

  db.prepare(
    `
      UPDATE telegram_messages
      SET student_id = ?,
          processed_at = datetime('now'),
          processing_status = 'error',
          error = ?
      WHERE id = ?
    `
  ).run(studentId, message, rowId);
}

function getChargeStatus(amount: number, paidAmount: number): LessonCharge["status"] {
  if (paidAmount <= 0) {
    return "unpaid";
  }

  return paidAmount >= amount ? "paid" : "partial";
}

function getStudentPrice(studentId: number): { amount: number; currency: string } {
  const row = db
    .prepare(
      `
        SELECT lesson_price_amount, lesson_price_currency
        FROM students
        WHERE id = ?
      `
    )
    .get(studentId) as
    | {
        lesson_price_amount: number;
        lesson_price_currency: string;
      }
    | undefined;

  return {
    amount: normalizeAmount(row?.lesson_price_amount),
    currency: row?.lesson_price_currency || "RUB",
  };
}

function getPaymentRemainingAmount(paymentId: number): number {
  const row = db
    .prepare(
      `
        SELECT
          COALESCE(payments.amount, 0) -
          COALESCE(SUM(payment_allocations.amount), 0) AS remaining_amount
        FROM payments
        LEFT JOIN payment_allocations
          ON payment_allocations.payment_id = payments.id
        WHERE payments.id = ?
        GROUP BY payments.id
      `
    )
    .get(paymentId) as { remaining_amount: number } | undefined;

  return normalizeAmount(row?.remaining_amount);
}

function allocatePaymentToOpenCharges(payment: PaymentRow): {
  allocatedAmount: number;
  paidLessonsCount: number;
} {
  let remainingAmount = normalizeAmount(payment.amount);
  remainingAmount = Math.min(remainingAmount, getPaymentRemainingAmount(payment.id));

  if (remainingAmount <= 0) {
    return { allocatedAmount: 0, paidLessonsCount: 0 };
  }

  const charges = db
    .prepare(
      `
        SELECT
          id,
          lesson_id,
          student_id,
          charge_type,
          amount,
          currency,
          status,
          paid_amount,
          note
        FROM lesson_charges
        WHERE student_id = ?
          AND currency = ?
          AND status IN ('unpaid', 'partial')
        ORDER BY created_at ASC, id ASC
      `
    )
    .all(payment.student_id, payment.currency) as LessonCharge[];

  let allocatedAmount = 0;
  let paidLessonsCount = 0;

  for (const charge of charges) {
    if (remainingAmount <= 0) {
      break;
    }

    const chargeRemaining = Math.max(0, charge.amount - charge.paid_amount);

    if (chargeRemaining <= 0) {
      continue;
    }

    const allocationAmount = Math.min(remainingAmount, chargeRemaining);
    const paidAmount = charge.paid_amount + allocationAmount;
    const previousStatus = charge.status;
    const status = getChargeStatus(charge.amount, paidAmount);

    db.prepare(
      `
        INSERT INTO payment_allocations (
          payment_id,
          lesson_charge_id,
          amount
        )
        VALUES (?, ?, ?)
      `
    ).run(payment.id, charge.id, allocationAmount);

    db.prepare(
      `
        UPDATE lesson_charges
        SET paid_amount = ?,
            status = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(paidAmount, status, charge.id);

    if (
      charge.charge_type === "lesson" &&
      previousStatus !== "paid" &&
      status === "paid"
    ) {
      paidLessonsCount += 1;
    }

    allocatedAmount += allocationAmount;
    remainingAmount -= allocationAmount;
  }

  return { allocatedAmount, paidLessonsCount };
}

function allocateAvailablePaymentsToStudentCharges(studentId: number): void {
  const price = getStudentPrice(studentId);
  const payments = db
    .prepare(
      `
        SELECT
          payments.id,
          payments.student_id,
          payments.amount,
          payments.currency,
          payments.status
        FROM payments
        LEFT JOIN payment_allocations
          ON payment_allocations.payment_id = payments.id
        WHERE payments.student_id = ?
          AND payments.status = 'confirmed'
          AND payments.currency = ?
          AND COALESCE(payments.amount, 0) > 0
        GROUP BY payments.id
        HAVING COALESCE(payments.amount, 0) >
          COALESCE(SUM(payment_allocations.amount), 0)
        ORDER BY payments.paid_at ASC, payments.id ASC
      `
    )
    .all(studentId, price.currency) as PaymentRow[];

  for (const payment of payments) {
    allocatePaymentToOpenCharges(payment);
  }
}

function buildDuplicateResult(input: {
  payment: PaymentRow;
  studentId: number;
  amount: number;
  currency: string;
  duplicateReason: PaymentApplicationResult["duplicateReason"];
}): PaymentApplicationResult {
  const summary = getStudentBalanceSummary(input.studentId);

  return {
    paymentId: input.payment.id,
    studentId: input.studentId,
    amount: normalizeAmount(input.payment.amount),
    currency: input.payment.currency,
    lessonPriceAmount: getStudentPrice(input.studentId).amount,
    allocatedAmount: 0,
    paidLessonsCount: 0,
    remainingDebtAmount: summary.unpaid_amount,
    prepaidAmount: summary.prepaid_amount,
    prepaidLessonsCount: summary.prepaid_lessons_count,
    duplicate: true,
    conflict: false,
    duplicateReason: input.duplicateReason,
    confirmationMessageSent: false,
  };
}

function buildConflictResult(input: {
  payment: PaymentRow;
  studentId: number;
  newAmount: number;
  newCurrency: string;
  conflictMessage: string;
  duplicateReason: PaymentApplicationResult["duplicateReason"];
}): PaymentApplicationResult {
  const summary = getStudentBalanceSummary(input.studentId);

  return {
    paymentId: input.payment.id,
    studentId: input.studentId,
    amount: normalizeAmount(input.payment.amount),
    currency: input.payment.currency,
    lessonPriceAmount: getStudentPrice(input.studentId).amount,
    allocatedAmount: 0,
    paidLessonsCount: 0,
    remainingDebtAmount: summary.unpaid_amount,
    prepaidAmount: summary.prepaid_amount,
    prepaidLessonsCount: summary.prepaid_lessons_count,
    duplicate: true,
    conflict: true,
    conflictMessage: input.conflictMessage,
    duplicateReason: input.duplicateReason,
    confirmationMessageSent: false,
  };
}

function handleExistingReceiptPayment(input: {
  payment: PaymentRow;
  studentId: number;
  amount: number;
  currency: string;
  telegramMessageRowId?: number;
  telegramMessageId: string;
  duplicateReason: PaymentApplicationResult["duplicateReason"];
}): PaymentApplicationResult {
  const existingAmount = normalizeAmount(input.payment.amount);
  const matchesExistingPayment =
    existingAmount === input.amount && input.payment.currency === input.currency;

  if (!matchesExistingPayment) {
    const conflictMessage = `payment conflict detected: existing ${existingAmount} ${input.payment.currency}, new ${input.amount} ${input.currency}`;

    console.error("payment conflict detected", {
      telegramMessageId: input.telegramMessageId,
      existingPaymentId: input.payment.id,
      existingAmount,
      existingCurrency: input.payment.currency,
      newlyExtractedAmount: input.amount,
      newlyExtractedCurrency: input.currency,
      duplicateReason: input.duplicateReason,
    });

    markTelegramMessageConflictIfNeeded(
      input.telegramMessageRowId,
      input.studentId,
      conflictMessage
    );

    return buildConflictResult({
      payment: input.payment,
      studentId: input.studentId,
      newAmount: input.amount,
      newCurrency: input.currency,
      conflictMessage,
      duplicateReason: input.duplicateReason,
    });
  }

  markTelegramMessageProcessedIfNeeded(input.telegramMessageRowId, input.studentId);

  return buildDuplicateResult({
    payment: input.payment,
    studentId: input.studentId,
    amount: input.amount,
    currency: input.currency,
    duplicateReason: input.duplicateReason,
  });
}

export function createLessonChargeForCompletedLesson(
  lessonId: number
): LessonCharge | undefined {
  const lesson = db
    .prepare(
      `
        SELECT
          lessons.id,
          lessons.status,
          students.id AS student_id,
          students.lesson_price_amount,
          students.lesson_price_currency
        FROM lessons
        JOIN students ON students.id = lessons.student_id
        WHERE lessons.id = ?
      `
    )
    .get(lessonId) as LessonForCharge | undefined;

  if (
    !lesson ||
    lesson.status === "cancelled" ||
    lesson.status === "cancelled_by_student" ||
    lesson.status === "cancelled_by_teacher"
  ) {
    return undefined;
  }

  const amount = normalizeAmount(lesson.lesson_price_amount);
  const currency = lesson.lesson_price_currency || "RUB";

  db.prepare(
    `
      INSERT OR IGNORE INTO lesson_charges (
        lesson_id,
        student_id,
        charge_type,
        amount,
        currency,
        status,
        paid_amount,
        updated_at
      )
      VALUES (?, ?, 'lesson', ?, ?, ?, 0, datetime('now'))
    `
  ).run(lesson.id, lesson.student_id, amount, currency, amount <= 0 ? "paid" : "unpaid");

  allocateAvailablePaymentsToStudentCharges(lesson.student_id);

  return db
    .prepare(
      `
        SELECT
          id,
          lesson_id,
          student_id,
          charge_type,
          amount,
          currency,
          status,
          paid_amount,
          note
        FROM lesson_charges
        WHERE lesson_id = ?
      `
    )
    .get(lessonId) as LessonCharge | undefined;
}

export function createManualCharge(
  studentId: number,
  amount: number,
  currency: string,
  note: string | null
): LessonCharge {
  return db.transaction(() => {
    const normalizedAmount = normalizeAmount(amount);
    const normalizedCurrency = currency.trim() || "RUB";

    if (normalizedAmount <= 0) {
      throw new Error("Manual debt amount must be greater than zero");
    }

    const insertResult = db
      .prepare(
        `
          INSERT INTO lesson_charges (
            lesson_id,
            student_id,
            charge_type,
            amount,
            currency,
            status,
            paid_amount,
            note,
            updated_at
          )
          VALUES (NULL, ?, 'manual', ?, ?, 'unpaid', 0, ?, datetime('now'))
        `
      )
      .run(studentId, normalizedAmount, normalizedCurrency, note);

    allocateAvailablePaymentsToStudentCharges(studentId);

    return db
      .prepare(
        `
          SELECT
            id,
            lesson_id,
            student_id,
            charge_type,
            amount,
            currency,
            status,
            paid_amount,
            note
          FROM lesson_charges
          WHERE id = ?
        `
      )
      .get(Number(insertResult.lastInsertRowid)) as LessonCharge;
  })();
}

function applyConfirmedPaymentToBalance(paymentId: number): PaymentApplicationResult {
  const payment = db
    .prepare(
      `
        SELECT id, student_id, amount, currency, status
        FROM payments
        WHERE id = ?
      `
    )
    .get(paymentId) as PaymentRow | undefined;

  if (!payment) {
    throw new Error(`Payment ${paymentId} not found`);
  }

  if (payment.status !== "confirmed") {
    throw new Error(`Payment ${paymentId} is not confirmed`);
  }

  const allocation = allocatePaymentToOpenCharges(payment);
  const afterSummary = getStudentBalanceSummary(payment.student_id);

  return {
    paymentId: payment.id,
    studentId: payment.student_id,
    amount: normalizeAmount(payment.amount),
    currency: payment.currency,
    lessonPriceAmount: getStudentPrice(payment.student_id).amount,
    allocatedAmount: allocation.allocatedAmount,
    paidLessonsCount: allocation.paidLessonsCount,
    remainingDebtAmount: afterSummary.unpaid_amount,
    prepaidAmount: afterSummary.prepaid_amount,
    prepaidLessonsCount: afterSummary.prepaid_lessons_count,
    duplicate: false,
    conflict: false,
    confirmationMessageSent: false,
  };
}

export function applyPaymentToStudentBalance(
  paymentId: number
): PaymentApplicationResult {
  const result = db.transaction(() => applyConfirmedPaymentToBalance(paymentId))();

  notifyManageSpendAfterCommit(result);

  return result;
}

export function createReceiptPaymentAndApply(
  input: CreateReceiptPaymentInput
): PaymentApplicationResult {
  const result = db.transaction(() => {
    const amount = normalizeAmount(input.aiResult.amount);
    const currency = normalizeReceiptCurrency(input.aiResult.currency);
    const documentNumber = normalizeReceiptIdentityValue(input.aiResult.document_number);
    const operationId = normalizeReceiptIdentityValue(input.aiResult.operation_id);
    const receiptFingerprint = generateReceiptFingerprint({
      studentId: input.studentId,
      amount,
      currency,
      paymentDate: input.aiResult.payment_date,
      documentNumber,
      operationId,
      sender: input.aiResult.sender,
      recipient: input.aiResult.recipient,
      receiptText: input.receiptText,
    });

    console.log("receipt processing lock/check started", {
      studentId: input.studentId,
      telegramMessageId: input.telegramMessageId,
      telegramMessageRowId: input.telegramMessageRowId ?? null,
    });
    console.log("extracted receipt document number", {
      studentId: input.studentId,
      telegramMessageId: input.telegramMessageId,
      documentNumber,
    });
    console.log("extracted operation id", {
      studentId: input.studentId,
      telegramMessageId: input.telegramMessageId,
      operationId,
    });
    console.log("generated receipt fingerprint", {
      studentId: input.studentId,
      telegramMessageId: input.telegramMessageId,
      receiptFingerprint,
    });

    const existingPayment = db
      .prepare(
        `
          SELECT id, student_id, amount, currency, status,
                 receipt_fingerprint, receipt_document_number, receipt_operation_id
          FROM payments
          WHERE telegram_message_id = ?
        `
      )
      .get(input.telegramMessageId) as PaymentRow | undefined;

    if (existingPayment) {
      console.log("existing payment found for telegram_message_id", {
        studentId: input.studentId,
        telegramMessageId: input.telegramMessageId,
        paymentId: existingPayment.id,
      });
      console.log("payment already exists for telegram_message_id, skipping", {
        studentId: input.studentId,
        telegramMessageId: input.telegramMessageId,
        paymentId: existingPayment.id,
      });
      console.log("payment creation skipped due to duplicate", {
        studentId: input.studentId,
        telegramMessageId: input.telegramMessageId,
        paymentId: existingPayment.id,
      });

      return handleExistingReceiptPayment({
        payment: existingPayment,
        studentId: input.studentId,
        amount,
        currency,
        telegramMessageRowId: input.telegramMessageRowId,
        telegramMessageId: input.telegramMessageId,
        duplicateReason: "telegram_message_id",
      });
    }

    if (amount <= 0) {
      throw new Error("Receipt payment amount is missing or zero");
    }

    const existingFingerprintPayment = db
      .prepare(
        `
          SELECT id, student_id, amount, currency, status,
                 receipt_fingerprint, receipt_document_number, receipt_operation_id
          FROM payments
          WHERE receipt_fingerprint = ?
        `
      )
      .get(receiptFingerprint) as PaymentRow | undefined;

    if (existingFingerprintPayment) {
      console.log("duplicate receipt found by fingerprint", {
        studentId: input.studentId,
        telegramMessageId: input.telegramMessageId,
        existingPaymentId: existingFingerprintPayment.id,
        receiptFingerprint,
      });

      return handleExistingReceiptPayment({
        payment: existingFingerprintPayment,
        studentId: input.studentId,
        amount,
        currency,
        telegramMessageRowId: input.telegramMessageRowId,
        telegramMessageId: input.telegramMessageId,
        duplicateReason: "receipt_fingerprint",
      });
    }

    if (documentNumber) {
      const existingDocumentPayment = db
        .prepare(
          `
            SELECT id, student_id, amount, currency, status,
                   receipt_fingerprint, receipt_document_number, receipt_operation_id
            FROM payments
            WHERE student_id = ?
              AND receipt_document_number = ?
          `
        )
        .get(input.studentId, documentNumber) as PaymentRow | undefined;

      if (existingDocumentPayment) {
        console.log("duplicate receipt found by document number", {
          studentId: input.studentId,
          telegramMessageId: input.telegramMessageId,
          existingPaymentId: existingDocumentPayment.id,
          documentNumber,
        });

        return handleExistingReceiptPayment({
          payment: existingDocumentPayment,
          studentId: input.studentId,
          amount,
          currency,
          telegramMessageRowId: input.telegramMessageRowId,
          telegramMessageId: input.telegramMessageId,
          duplicateReason: "document_number",
        });
      }
    }

    if (operationId) {
      const existingOperationPayment = db
        .prepare(
          `
            SELECT id, student_id, amount, currency, status,
                   receipt_fingerprint, receipt_document_number, receipt_operation_id
            FROM payments
            WHERE student_id = ?
              AND receipt_operation_id = ?
          `
        )
        .get(input.studentId, operationId) as PaymentRow | undefined;

      if (existingOperationPayment) {
        console.log("duplicate receipt found by operation id", {
          studentId: input.studentId,
          telegramMessageId: input.telegramMessageId,
          existingPaymentId: existingOperationPayment.id,
          operationId,
        });

        return handleExistingReceiptPayment({
          payment: existingOperationPayment,
          studentId: input.studentId,
          amount,
          currency,
          telegramMessageRowId: input.telegramMessageRowId,
          telegramMessageId: input.telegramMessageId,
          duplicateReason: "operation_id",
        });
      }
    }

    const insertResult = db
      .prepare(
        `
          INSERT INTO payments (
            lesson_id,
            student_id,
            status,
            amount,
            currency,
            receipt_received_at,
            paid_at,
            telegram_message_id,
            telegram_file_id,
            receipt_file_path,
            receipt_text,
            ai_amount,
            ai_currency,
            ai_payment_date,
            ai_confidence,
            ai_raw_result,
            ai_parser_source,
            receipt_fingerprint,
            receipt_document_number,
            receipt_operation_id,
            payment_method,
            updated_at
          )
          VALUES (
            NULL,
            ?,
            'confirmed',
            ?,
            ?,
            datetime('now'),
            datetime('now'),
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            'receipt',
            datetime('now')
          )
        `
      )
      .run(
        input.studentId,
        amount,
        currency,
        input.telegramMessageId,
        input.telegramFileId,
        input.receiptFilePath,
        input.receiptText,
        input.aiResult.amount,
        input.aiResult.currency,
        input.aiResult.payment_date,
        input.aiResult.confidence,
        JSON.stringify(input.aiResult),
        input.parserSource ?? "ai",
        receiptFingerprint,
        documentNumber,
        operationId
      );

    const paymentId = Number(insertResult.lastInsertRowid);
    const payment = db
      .prepare(
        `
          SELECT id, student_id, amount, currency, status
          FROM payments
          WHERE id = ?
        `
      )
      .get(paymentId) as PaymentRow;
    const allocation = allocatePaymentToOpenCharges(payment);
    const summary = getStudentBalanceSummary(input.studentId);

    markTelegramMessageProcessedIfNeeded(input.telegramMessageRowId, input.studentId);

    console.log("payment created once", {
      studentId: input.studentId,
      telegramMessageId: input.telegramMessageId,
      paymentId,
    });

    return {
      paymentId,
      studentId: input.studentId,
      amount,
      currency,
      lessonPriceAmount: getStudentPrice(input.studentId).amount,
      allocatedAmount: allocation.allocatedAmount,
      paidLessonsCount: allocation.paidLessonsCount,
      remainingDebtAmount: summary.unpaid_amount,
      prepaidAmount: summary.prepaid_amount,
      prepaidLessonsCount: summary.prepaid_lessons_count,
      duplicate: false,
      conflict: false,
      confirmationMessageSent: false,
    };
  })();

  notifyManageSpendAfterCommit(result);

  return result;
}

export function saveReceiptPaymentForManualReview(
  input: SaveReceiptForManualReviewInput
): { paymentId: number; duplicate: boolean } {
  return db.transaction(() => {
    const existingPayment = db
      .prepare(
        `
          SELECT id
          FROM payments
          WHERE telegram_message_id = ?
        `
      )
      .get(input.telegramMessageId) as { id: number } | undefined;

    if (existingPayment) {
      markTelegramMessageProcessedIfNeeded(input.telegramMessageRowId, input.studentId);
      return { paymentId: existingPayment.id, duplicate: true };
    }

    const amount = normalizeAmount(input.aiResult.amount);
    const currency = normalizeReceiptCurrency(input.aiResult.currency);
    const documentNumber = normalizeReceiptIdentityValue(input.aiResult.document_number);
    const operationId = normalizeReceiptIdentityValue(input.aiResult.operation_id);

    const insertResult = db
      .prepare(
        `
          INSERT INTO payments (
            lesson_id,
            student_id,
            status,
            amount,
            currency,
            receipt_received_at,
            telegram_message_id,
            telegram_file_id,
            receipt_file_path,
            receipt_text,
            ai_amount,
            ai_currency,
            ai_payment_date,
            ai_confidence,
            ai_raw_result,
            ai_parser_source,
            receipt_document_number,
            receipt_operation_id,
            payment_method,
            updated_at
          )
          VALUES (
            NULL,
            ?,
            'pending_manual_review',
            ?,
            ?,
            datetime('now'),
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            'receipt',
            datetime('now')
          )
        `
      )
      .run(
        input.studentId,
        amount > 0 ? amount : null,
        currency,
        input.telegramMessageId,
        input.telegramFileId,
        input.receiptFilePath,
        input.receiptText,
        input.aiResult.amount,
        input.aiResult.currency,
        input.aiResult.payment_date,
        input.aiResult.confidence,
        JSON.stringify(input.aiResult),
        input.parserSource ?? "ai",
        documentNumber,
        operationId
      );

    markTelegramMessageProcessedIfNeeded(input.telegramMessageRowId, input.studentId);

    return { paymentId: Number(insertResult.lastInsertRowid), duplicate: false };
  })();
}

export function createManualPaymentAndApply(
  studentId: number,
  amount: number,
  currency: string,
  lessonId?: number
): PaymentApplicationResult {
  const result = db.transaction(() => {
    const normalizedAmount = normalizeAmount(amount);

    if (normalizedAmount <= 0) {
      throw new Error("Manual payment amount must be greater than zero");
    }

    const insertResult = db
      .prepare(
        `
          INSERT INTO payments (
            lesson_id,
            student_id,
            status,
            amount,
            currency,
            paid_at,
            payment_method,
            updated_at
          )
          VALUES (?, ?, 'confirmed', ?, ?, datetime('now'), 'manual', datetime('now'))
        `
      )
      .run(lessonId ?? null, studentId, normalizedAmount, currency || "RUB");

    return applyConfirmedPaymentToBalance(Number(insertResult.lastInsertRowid));
  })();

  notifyManageSpendAfterCommit(result);

  return result;
}

export function confirmSingleLessonChargeManually(
  lessonId: number
): PaymentApplicationResult | undefined {
  return db.transaction(() => {
    const lesson = db
      .prepare(
        `
          SELECT status
          FROM lessons
          WHERE id = ?
        `
      )
      .get(lessonId) as { status: string } | undefined;

    if (
      !lesson ||
      lesson.status === "cancelled" ||
      lesson.status === "cancelled_by_student" ||
      lesson.status === "cancelled_by_teacher"
    ) {
      return undefined;
    }

    const charge =
      createLessonChargeForCompletedLesson(lessonId) ??
      (db
        .prepare(
          `
            SELECT
              id,
              lesson_id,
              student_id,
              charge_type,
              amount,
              currency,
              status,
              paid_amount,
              note
            FROM lesson_charges
            WHERE lesson_id = ?
          `
        )
        .get(lessonId) as LessonCharge | undefined);

    if (!charge) {
      return undefined;
    }

    const remainingAmount = Math.max(0, charge.amount - charge.paid_amount);

    if (remainingAmount <= 0) {
      return {
        paymentId: 0,
        studentId: charge.student_id,
        amount: 0,
        currency: charge.currency,
        lessonPriceAmount: getStudentPrice(charge.student_id).amount,
        allocatedAmount: 0,
        paidLessonsCount: 0,
        remainingDebtAmount: getStudentBalanceSummary(charge.student_id).unpaid_amount,
        prepaidAmount: getStudentBalanceSummary(charge.student_id).prepaid_amount,
        prepaidLessonsCount:
          getStudentBalanceSummary(charge.student_id).prepaid_lessons_count,
        duplicate: false,
        conflict: false,
        confirmationMessageSent: false,
      };
    }

    return createManualPaymentAndApply(
      charge.student_id,
      remainingAmount,
      charge.currency,
      lessonId
    );
  })();
}

export function getStudentBalanceSummary(studentId: number): StudentBalanceSummary {
  const price = getStudentPrice(studentId);
  const chargeSummary = db
    .prepare(
      `
        SELECT
          COALESCE(SUM(
            CASE
              WHEN charge_type = 'lesson' THEN 1
              ELSE 0
            END
          ), 0) AS unpaid_lessons_count,
          COALESCE(SUM(amount - paid_amount), 0) AS unpaid_amount
        FROM lesson_charges
        WHERE student_id = ?
          AND currency = ?
          AND status IN ('unpaid', 'partial')
      `
    )
    .get(studentId, price.currency) as {
    unpaid_lessons_count: number;
    unpaid_amount: number;
  };

  const paymentSummary = db
    .prepare(
      `
        SELECT
          COALESCE(SUM(payments.amount), 0) AS total_payments,
          COALESCE((
            SELECT SUM(payment_allocations.amount)
            FROM payment_allocations
            JOIN payments AS allocated_payments
              ON allocated_payments.id = payment_allocations.payment_id
            WHERE allocated_payments.student_id = ?
              AND allocated_payments.status = 'confirmed'
              AND allocated_payments.currency = ?
          ), 0) AS allocated_amount
        FROM payments
        WHERE student_id = ?
          AND status = 'confirmed'
          AND currency = ?
      `
    )
    .get(studentId, price.currency, studentId, price.currency) as {
    total_payments: number;
    allocated_amount: number;
  };

  const prepaidAmount = Math.max(
    0,
    normalizeAmount(paymentSummary.total_payments) -
      normalizeAmount(paymentSummary.allocated_amount)
  );

  const unpaidAmount = normalizeAmount(chargeSummary.unpaid_amount);

  return {
    unpaid_lessons_count:
      price.amount > 0 ? Math.ceil(unpaidAmount / price.amount) : 0,
    unpaid_amount: unpaidAmount,
    prepaid_amount: prepaidAmount,
    prepaid_lessons_count:
      price.amount > 0 ? Math.floor(prepaidAmount / price.amount) : 0,
    currency: price.currency,
  };
}
