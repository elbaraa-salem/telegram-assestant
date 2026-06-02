import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";
import { Api, TelegramClient } from "telegram";
import { db } from "../database/db";
import { getTelegramClient } from "./telegramClient";
import {
  analyzeReceiptText,
  extractTextFromPdf,
  ReceiptAiResult,
} from "./receiptAnalysisService";
import { analyzeStudentReplyIntent } from "./studentReplyAiService";
import { createReceiptPaymentAndApply } from "./paymentBalanceService";

const recentLessonWindowHours = 4;
const cancellationDeadlineHours = Number(
  process.env.CANCELLATION_DEADLINE_HOURS ?? 10
);
const reconnectDelayMs = 3_000;
const healthCheckIntervalMs = 60_000;
const pollingIntervalMs = Number(
  process.env.TELEGRAM_LISTENER_POLL_INTERVAL_MS ?? 5_000
);
const pollingLimit = Number(process.env.TELEGRAM_LISTENER_POLL_LIMIT ?? 5);
const pollingEnabled =
  String(process.env.TELEGRAM_LISTENER_ENABLE_POLLING ?? "false").toLowerCase() ===
  "true";
const minimumStudentReplyAiConfidence = 0.75;
const staleProcessingMessageMs = 5 * 60 * 1000;
const studentReplyClarificationMessage =
  "Я не совсем понял ответ. Напиши, пожалуйста:\n1 — да, я готов\n2 — нет, нужно отменить";
const activeTelegramMessageLocks = new Set<string>();

type Student = {
  id: number;
  telegram_id: string;
  telegram_username?: string | null;
  name_ru?: string | null;
  name_ar?: string | null;
};

type ReceiptTargetPayment = {
  id: number;
  status: string;
  lesson_id: number;
};

type ReceiptTargetLesson = {
  id: number;
  start_time: string;
};

type ClassifiedPdfReceipt = {
  extractedText: string;
  aiResult: ReceiptAiResult;
};

type Lesson = {
  id: number;
  start_time: string;
  status: string;
  reminder_sent: number;
  reminder_sent_at: string | null;
  student_response: string | null;
  awaiting_cancellation_reason: number;
  cancellation_reason: string | null;
};

function normalizeLessonTimestamp(startTime: string): string {
  return startTime.replace(/([+-]\d{2})$/, "$1:00");
}

function parseLessonTimestamp(startTime: string): number {
  return Date.parse(normalizeLessonTimestamp(startTime));
}

export function findActiveScheduledRemindedLesson(studentId: number): Lesson | null {
  const now = Date.now();
  const graceCutoff = now - recentLessonWindowHours * 60 * 60 * 1000;
  const lessons = db
    .prepare(
      `
        SELECT
          id,
          start_time,
          status,
          reminder_sent,
          reminder_sent_at,
          student_response,
          awaiting_cancellation_reason,
          cancellation_reason
        FROM lessons
        WHERE student_id = ?
          AND status = 'scheduled'
          AND google_deleted_at IS NULL
          AND COALESCE(google_status, '') != 'deleted'
          AND (
            reminder_sent_at IS NOT NULL
            OR reminder_sent = 1
          )
          AND student_response IS NULL
      `
    )
    .all(studentId) as Lesson[];

  return (
    lessons
      .map((lesson) => ({
        lesson,
        startTimeMs: parseLessonTimestamp(lesson.start_time),
      }))
      .filter(
        ({ startTimeMs }) =>
          !Number.isNaN(startTimeMs) && startTimeMs > graceCutoff
      )
      .sort((left, right) => left.startTimeMs - right.startTimeMs)[0]
      ?.lesson ?? null
  );
}

function findStudentByTelegramId(telegramId: string): Student | undefined {
  return db
    .prepare(
      `
        SELECT id, telegram_id, name_ru, name_ar
        FROM students
        WHERE telegram_id = ?
      `
    )
    .get(telegramId) as Student | undefined;
}

function normalizeTelegramUsername(username: string): string {
  const trimmed = username.trim();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function findStudentByTelegramUsername(username: string): Student | undefined {
  return db
    .prepare(
      `
        SELECT id, telegram_id, telegram_username, name_ru, name_ar
        FROM students
        WHERE telegram_username = ?
      `
    )
    .get(username) as Student | undefined;
}

function getDocumentFilename(document: Api.Document): string | undefined {
  const filenameAttribute = document.attributes.find(
    (attribute): attribute is Api.DocumentAttributeFilename =>
      attribute instanceof Api.DocumentAttributeFilename
  );

  return filenameAttribute?.fileName;
}

function getMessageDocument(
  message: NewMessageEvent["message"]
): Api.Document | undefined {
  if (message.document) {
    return message.document;
  }

  if (
    message.media instanceof Api.MessageMediaDocument &&
    message.media.document instanceof Api.Document
  ) {
    return message.media.document;
  }

  return undefined;
}

function isPdfDocument(document: Api.Document): boolean {
  return (
    document.mimeType === "application/pdf" ||
    getDocumentFilename(document)?.toLowerCase().endsWith(".pdf") === true
  );
}

const minimumReceiptConfidence = 0.8;

function formatLessonCountRu(count: number): string {
  const absoluteCount = Math.abs(count);
  const lastTwoDigits = absoluteCount % 100;
  const lastDigit = absoluteCount % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return `${count} уроков`;
  }

  if (lastDigit === 1) {
    return `${count} урок`;
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return `${count} урока`;
  }

  return `${count} уроков`;
}

function findLatestLessonForReceipt(studentId: number): ReceiptTargetLesson | undefined {
  const latestPastOrCurrent = db
    .prepare(
      `
        SELECT id, start_time
        FROM lessons
        WHERE student_id = ?
          AND datetime(start_time) <= datetime('now')
        ORDER BY datetime(start_time) DESC, id DESC
        LIMIT 1
      `
    )
    .get(studentId) as ReceiptTargetLesson | undefined;

  if (latestPastOrCurrent) {
    return latestPastOrCurrent;
  }

  return db
    .prepare(
      `
        SELECT id, start_time
        FROM lessons
        WHERE student_id = ?
          AND datetime(start_time) > datetime('now')
        ORDER BY datetime(start_time) ASC, id ASC
        LIMIT 1
      `
    )
    .get(studentId) as ReceiptTargetLesson | undefined;
}

function findNextUpcomingLesson(
  studentId: number,
  afterStartTime: string
): ReceiptTargetLesson | undefined {
  return db
    .prepare(
      `
        SELECT id, start_time
        FROM lessons
        WHERE student_id = ?
          AND datetime(start_time) > datetime(?)
          AND datetime(start_time) > datetime('now')
        ORDER BY datetime(start_time) ASC, id ASC
        LIMIT 1
      `
    )
    .get(studentId, afterStartTime) as ReceiptTargetLesson | undefined;
}

function findReceiptTargetPaymentForStudent(
  studentId: number
): ReceiptTargetPayment | undefined {
  const latestLesson = findLatestLessonForReceipt(studentId);

  if (!latestLesson) {
    return undefined;
  }

  const nextLesson = findNextUpcomingLesson(studentId, latestLesson.start_time);

  if (!nextLesson) {
    return undefined;
  }

  return {
    id: 0,
    status: "unpaid",
    lesson_id: nextLesson.id,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function getDownloadResultType(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return "Buffer";
  }

  if (value instanceof Uint8Array) {
    return "Uint8Array";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

function isBinaryDownloadResult(value: unknown): value is Buffer | Uint8Array {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function getDownloadBufferLength(value: unknown): number | null {
  if (isBinaryDownloadResult(value)) {
    return value.length;
  }

  return null;
}

function getVerifiedFileSize(filePath: string): number | null {
  if (!fsSync.existsSync(filePath)) {
    return null;
  }

  return fsSync.statSync(filePath).size;
}

async function writeDownloadResultToTempFile(
  downloadResult: unknown,
  tempPath: string
): Promise<void> {
  if (Buffer.isBuffer(downloadResult)) {
    await fs.writeFile(tempPath, downloadResult);
    return;
  }

  if (downloadResult instanceof Uint8Array) {
    await fs.writeFile(tempPath, Buffer.from(downloadResult));
  }
}

async function handlePdfReceipt(
  client: TelegramClient,
  message: NewMessageEvent["message"],
  student: Student,
  document: Api.Document,
  telegramMessageRowId: number
): Promise<"saved_receipt" | "ignored"> {
  if (!isPdfDocument(document)) {
    console.log("Document received but not PDF");
    return "ignored";
  }

  const receiptsDir = path.join(process.cwd(), "data", "receipts");
  const tempDir = path.join(receiptsDir, "tmp");
  const tempPath = path.join(
    tempDir,
    `student-${student.id}-message-${message.id.toString()}.pdf`
  );
  const receiptPath = path.join(
    receiptsDir,
    `student-${student.id}-message-${message.id.toString()}-receipt.pdf`
  );
  let receiptSaved = false;
  const documentFilename = getDocumentFilename(document) ?? null;

  console.log("PDF receipt handler started", {
    studentId: student.id,
    senderId: student.telegram_id,
    messageId: message.id.toString(),
  });

  await fs.mkdir(receiptsDir, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  try {
    console.log("pdf download started", {
      studentId: student.id,
      messageId: message.id.toString(),
      filename: documentFilename,
      mimeType: document.mimeType,
      tempPath,
      finalPath: receiptPath,
    });

    const downloadResult: unknown = await message.downloadMedia();
    const downloadResultType = getDownloadResultType(downloadResult);
    const downloadBufferLength = getDownloadBufferLength(downloadResult);

    console.log("download result type", {
      studentId: student.id,
      messageId: message.id.toString(),
      type: downloadResultType,
    });
    console.log("download buffer length", {
      studentId: student.id,
      messageId: message.id.toString(),
      bufferLength: downloadBufferLength,
    });

    if (downloadBufferLength === 0) {
      throw new Error("Downloaded PDF buffer is empty");
    }

    if (isBinaryDownloadResult(downloadResult)) {
      console.log("temp file write started", {
        studentId: student.id,
        messageId: message.id.toString(),
        tempPath,
      });
      await writeDownloadResultToTempFile(downloadResult, tempPath);
      console.log("temp file write completed", {
        studentId: student.id,
        messageId: message.id.toString(),
        tempPath,
      });
    }

    const tempFileSize = getVerifiedFileSize(tempPath);
    console.log("temp file exists", {
      studentId: student.id,
      messageId: message.id.toString(),
      tempPath,
      exists: tempFileSize !== null,
    });

    if (tempFileSize === null) {
      console.error("PDF temp file was not created after download", {
        messageId: message.id.toString(),
        filename: documentFilename,
        mimeType: document.mimeType,
        tempPath,
        finalPath: receiptPath,
        downloadResultType,
        downloadBufferLength,
      });
      throw new Error("PDF temp file was not created after download");
    }

    console.log("temp file size", {
      studentId: student.id,
      messageId: message.id.toString(),
      tempPath,
      size: tempFileSize,
    });

    if (tempFileSize === 0) {
      console.log("pdf ignored: downloaded file is empty", {
        studentId: student.id,
        messageId: message.id.toString(),
        path: tempPath,
      });
      throw new Error("pdf ignored: downloaded file is empty");
    }

    console.log("PDF downloaded", {
      studentId: student.id,
      messageId: message.id.toString(),
      path: tempPath,
      size: tempFileSize,
    });

    console.log("rename started", {
      studentId: student.id,
      messageId: message.id.toString(),
      tempPath,
      finalPath: receiptPath,
    });
    await fs.rename(tempPath, receiptPath);
    console.log("rename completed", {
      studentId: student.id,
      messageId: message.id.toString(),
      tempPath,
      finalPath: receiptPath,
    });

    const finalFileSize = getVerifiedFileSize(receiptPath);
    console.log("final file exists", {
      studentId: student.id,
      messageId: message.id.toString(),
      finalPath: receiptPath,
      exists: finalFileSize !== null,
    });

    if (finalFileSize === null) {
      throw new Error("PDF final file was not created after rename");
    }

    console.log("final file size", {
      studentId: student.id,
      messageId: message.id.toString(),
      finalPath: receiptPath,
      size: finalFileSize,
    });

    if (finalFileSize === 0) {
      throw new Error("PDF final file is empty after rename");
    }

    receiptSaved = true;

    const extractedText = await extractTextFromPdf(receiptPath);
    console.log("receipt text extracted", {
      studentId: student.id,
      messageId: message.id.toString(),
      textLength: extractedText.length,
    });

    console.log("AI receipt analysis started", {
      studentId: student.id,
      messageId: message.id.toString(),
    });
    const analysis: ClassifiedPdfReceipt = {
      extractedText,
      aiResult: await analyzeReceiptText(extractedText),
    };
    const result = analysis.aiResult;
    console.log("AI receipt analysis result", {
      studentId: student.id,
      messageId: message.id.toString(),
      isPaymentReceipt: result.is_payment_receipt,
      paymentConfirmed: result.payment_confirmed,
      amount: result.amount,
      currency: result.currency,
      confidence: result.confidence,
      reason: result.reason,
    });

    const confidentReceipt =
      result.is_payment_receipt === true &&
      result.payment_confirmed === true &&
      result.confidence !== null &&
      result.confidence >= minimumReceiptConfidence;

    if (!confidentReceipt) {
      console.log("pdf ignored: not a receipt", {
        studentId: student.id,
        senderId: student.telegram_id,
        messageId: message.id.toString(),
        isPaymentReceipt: result.is_payment_receipt,
        paymentConfirmed: result.payment_confirmed,
        confidence: result.confidence,
      });
      return "ignored";
    }

    console.log("Payment receipt detected", {
      studentId: student.id,
      amount: result.amount,
      currency: result.currency,
      confidence: result.confidence,
    });
    console.log("receipt accepted without pending payment request", {
      studentId: student.id,
      messageId: message.id.toString(),
    });

    const earlyPaymentTarget = findReceiptTargetPaymentForStudent(student.id);
    if (earlyPaymentTarget) {
      console.log("Target lesson selected for receipt", {
        studentId: student.id,
        lessonId: earlyPaymentTarget.lesson_id,
      });
    }

    const application = createReceiptPaymentAndApply({
      studentId: student.id,
      telegramMessageRowId,
      telegramMessageId: message.id.toString(),
      telegramFileId: document.id.toString(),
      receiptFilePath: receiptPath,
      receiptText: analysis.extractedText,
      aiResult: result,
    });

    if (application.conflict) {
      throw new Error(
        application.conflictMessage ??
          `payment conflict for telegram_message_id ${message.id.toString()}`
      );
    }

    if (application.duplicate) {
      if (application.duplicateReason !== "telegram_message_id") {
        await safelySendStudentMessage(
          client,
          student,
          "Этот чек уже был учтён ранее ✅"
        );
      }
      return "ignored";
    }

    console.log("payment saved", {
      studentId: student.id,
      paymentId: application.paymentId,
      messageId: message.id.toString(),
      amount: application.amount,
      currency: application.currency,
      allocatedAmount: application.allocatedAmount,
      prepaidAmount: application.prepaidAmount,
    });
    if (application.allocatedAmount === 0) {
      console.log("no debt found, adding full payment to prepaid balance", {
        studentId: student.id,
        paymentId: application.paymentId,
        amount: application.amount,
        currency: application.currency,
        prepaidAmount: application.prepaidAmount,
      });
    }

    const responseMessage =
      application.remainingDebtAmount > 0
        ? `Спасибо, оплата получена ✅

Сумма: ${application.amount} ${application.currency}.
Осталось к оплате: ${application.remainingDebtAmount} ${application.currency}.`
        : application.paidLessonsCount > 0
          ? `Спасибо, оплата получена ✅

Сумма: ${application.amount} ${application.currency}.
Погашено неоплаченных уроков: ${application.paidLessonsCount}.
Осталось на балансе: ${formatLessonCountRu(application.prepaidLessonsCount)}.`
          : `Спасибо, оплата получена ✅

Сумма: ${application.amount} ${application.currency}.
Стоимость одного урока: ${application.lessonPriceAmount} ${application.currency}.
На балансе: ${formatLessonCountRu(application.prepaidLessonsCount)}.`;

    await safelySendStudentMessage(client, student, responseMessage);
    console.log("confirmation message sent once", {
      studentId: student.id,
      paymentId: application.paymentId,
      telegramMessageId: message.id.toString(),
    });

    return "saved_receipt";
  } catch (error) {
    console.error("PDF receipt handler failed", {
      studentId: student.id,
      messageId: message.id.toString(),
      error: getErrorMessage(error),
    });
    throw error;
  } finally {
    if (!receiptSaved) {
      await fs.rm(tempPath, { force: true });
    }
  }
}

type ProcessingSource = "event" | "polling";
type ProcessingAction =
  | "confirmed_lesson"
  | "cancelled_lesson"
  | "cancellation_reason"
  | "saved_receipt"
  | "ignored"
  | "duplicate";

type StoredTelegramMessage = {
  id: number;
  processing_status: string | null;
  has_media: number;
  media_type: string | null;
  processed_at: string | null;
  created_at: string;
};

type StudentReplyIntent = "ready" | "cancel" | "cancellation_reason" | "unknown";
type StudentMessageState =
  | "awaiting_cancellation_reason"
  | "awaiting_reminder_response"
  | "passive";
export type StudentTextClassification = {
  state: StudentMessageState;
  intent: StudentReplyIntent;
  shouldSendUnknownReminderReply: boolean;
};
type EntityResolvingTelegramClient = Pick<
  TelegramClient,
  "getInputEntity" | "getDialogs"
>;

function isLessonCancelledStatus(status: string): boolean {
  return (
    status === "cancelled" ||
    status === "cancelled_by_student" ||
    status === "cancelled_by_teacher"
  );
}

function normalizeReplyText(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[.,!?،؛:;]/g, "")
    .replace(/\s+/g, " ");
}

function hasClearCancellationIntent(normalized: string): boolean {
  if (normalized === "2") {
    return true;
  }

  const exactCancellationPhrases = new Set([
    "нет нужно отменить",
    "не могу",
    "не получится",
    "отмена",
    "отменить",
    "нужно отменить",
    "я не смогу",
    "не смогу прийти",
    "не готов",
    "مش هقدر",
    "مش هقدر احضر",
    "مش هقدر أحضر",
    "لا استطيع",
    "لا أستطيع",
    "لا استطيع الحضور",
    "لن استطيع الحضور",
    "لن أستطيع الحضور",
  ]);

  if (exactCancellationPhrases.has(normalized)) {
    return true;
  }

  return (
    normalized.includes("отмени") ||
    normalized.includes("отменить") ||
    normalized.includes("отменим") ||
    normalized.includes("отмена") ||
    normalized.includes("отмену") ||
    normalized.includes("cancel") ||
    normalized.includes("не смогу") ||
    normalized.includes("не успею") ||
    normalized.includes("не получится") ||
    normalized.includes("не выйдет") ||
    ((normalized.includes("не могу") ||
      normalized.includes("не получается")) &&
      (normalized.includes("прийти") ||
        normalized.includes("быть") ||
        normalized.includes("попасть") ||
        normalized.includes("успеть") ||
        normalized.includes("заниматься"))) ||
    normalized.includes("عاوز ألغي") ||
    normalized.includes("عايز الغي") ||
    normalized.includes("عاوز الغي") ||
    normalized.includes("عاوزة الغي") ||
    normalized.includes("عاوزة ألغي") ||
    normalized.includes("الغي الدرس") ||
    normalized.includes("ألغي الدرس") ||
    normalized.includes("نلغي") ||
    normalized.includes("إلغاء") ||
    normalized.includes("الغاء") ||
    normalized.includes("مش هقدر") ||
    normalized.includes("لن استطيع") ||
    normalized.includes("لن أستطيع") ||
    normalized.includes("لا استطيع الحضور") ||
    normalized.includes("لا أستطيع الحضور")
  );
}

function hasClearReadyIntent(normalized: string): boolean {
  const readyPhrases = new Set([
    "1",
    "да",
    "да я готов",
    "да я готова",
    "я готов",
    "я готова",
    "готов",
    "готова",
    "буду",
    "+",
    "yes",
    "نعم",
    "نعم انا جاهز",
    "نعم أنا جاهز",
    "انا جاهز",
    "أنا جاهز",
    "انا جاهزة",
    "أنا جاهزة",
    "جاهز",
    "جاهزة",
  ]);

  return readyPhrases.has(normalized);
}

function parseStudentReplyIntent(
  text: string
): Exclude<StudentReplyIntent, "cancellation_reason"> {
  const normalized = normalizeReplyText(text);

  if (hasClearCancellationIntent(normalized)) {
    return "cancel";
  }

  if (hasClearReadyIntent(normalized)) {
    return "ready";
  }

  return "unknown";
}

function parseReminderReplyIntent(
  text: string
): Exclude<StudentReplyIntent, "cancellation_reason"> {
  const normalized = normalizeReplyText(text);

  if (normalized === "нет") {
    return "cancel";
  }

  return parseStudentReplyIntent(text);
}

function isAwaitingReminderResponse(lesson: Lesson): boolean {
  return (
    (lesson.reminder_sent === 1 || Boolean(lesson.reminder_sent_at)) &&
    lesson.awaiting_cancellation_reason !== 1 &&
    lesson.student_response === null &&
    !isLessonCancelledStatus(lesson.status) &&
    lesson.status !== "completed"
  );
}

function getStudentMessageState(lesson: Lesson): StudentMessageState {
  if (lesson.awaiting_cancellation_reason === 1) {
    return "awaiting_cancellation_reason";
  }

  if (isAwaitingReminderResponse(lesson)) {
    return "awaiting_reminder_response";
  }

  return "passive";
}

export function classifyStudentTextForLesson(
  lesson: Lesson,
  text: string
): StudentTextClassification {
  const state = getStudentMessageState(lesson);

  if (state === "awaiting_cancellation_reason" && text.trim()) {
    const overrideIntent = parseExplicitCancellationReasonOverride(text);

    return {
      state,
      intent:
        overrideIntent === "unknown" ? "cancellation_reason" : overrideIntent,
      shouldSendUnknownReminderReply: false,
    };
  }

  const intent =
    state === "awaiting_reminder_response"
      ? parseReminderReplyIntent(text)
      : parseStudentReplyIntent(text);

  return {
    state,
    intent,
    shouldSendUnknownReminderReply:
      intent === "unknown" &&
      state === "awaiting_reminder_response" &&
      isProbablyUnclearReminderReply(text),
  };
}

function isProbablyUnclearReminderReply(text: string): boolean {
  const normalized = normalizeReplyText(text);

  if (!normalized) {
    return false;
  }

  if (/^[12]?[+-]?$/.test(normalized)) {
    return true;
  }

  if (normalized.length > 40) {
    return false;
  }

  return (
    normalized.includes("да") ||
    normalized.includes("нет") ||
    normalized.includes("готов") ||
    normalized.includes("готова") ||
    normalized.includes("могу") ||
    normalized.includes("смогу") ||
    normalized.includes("буду") ||
    /\b(ok|okay|yes|no)\b/.test(normalized)
  );
}

function extractCancellationReasonFromCancellationText(text: string): string | null {
  const trimmed = text.trim();
  const normalized = normalizeReplyText(trimmed);
  const commandOnlyPhrases = new Set([
    "2",
    "нет",
    "отмена",
    "отменить",
    "нужно отменить",
    "عاوز ألغي",
    "عايز الغي",
    "عاوز الغي",
  ]);

  if (!trimmed || commandOnlyPhrases.has(normalized)) {
    return null;
  }

  return trimmed;
}

function parseExplicitCancellationReasonOverride(
  text: string
): Exclude<StudentReplyIntent, "cancellation_reason"> {
  const normalized = normalizeReplyText(text);

  if (normalized === "1") {
    return "ready";
  }

  if (normalized === "2") {
    return "cancel";
  }

  return "unknown";
}

function getMessageType(
  message: NewMessageEvent["message"],
  document: Api.Document | undefined
): "text" | "pdf" | "other" {
  if (document && isPdfDocument(document)) {
    return "pdf";
  }

  return message.message?.trim() ? "text" : "other";
}

function isTelegramEntityResolveError(error: unknown): boolean {
  const message = getErrorMessage(error);

  return (
    message.includes("Could not find the input entity") ||
    message.includes("Cannot find any entity corresponding to") ||
    message.includes("Could not find input entity")
  );
}

function getStudentTelegramTargets(student: Student): string[] {
  const targets = [
    student.telegram_id?.trim(),
    student.telegram_username?.trim(),
  ].filter((target): target is string => Boolean(target));

  return [...new Set(targets)];
}

export async function safeResolveInputEntity(
  client: EntityResolvingTelegramClient,
  targets: Array<string | null | undefined>
): Promise<Api.TypeInputPeer | null> {
  const cleanTargets = [
    ...new Set(
      targets
        .map((target) => target?.trim())
        .filter((target): target is string => Boolean(target))
    ),
  ];

  for (const target of cleanTargets) {
    try {
      return await client.getInputEntity(target);
    } catch (error) {
      console.warn("telegram entity resolve failed; message skipped", {
        target,
        error: getErrorMessage(error),
      });

      if (!isTelegramEntityResolveError(error)) {
        return null;
      }
    }
  }

  try {
    await client.getDialogs({});
  } catch (error) {
    console.warn("telegram dialogs refresh failed during entity resolve", {
      error: getErrorMessage(error),
    });
  }

  for (const target of cleanTargets) {
    try {
      return await client.getInputEntity(target);
    } catch (error) {
      console.warn("telegram entity resolve failed after dialogs refresh", {
        target,
        error: getErrorMessage(error),
      });
    }
  }

  return null;
}

async function safelySendStudentMessage(
  client: TelegramClient,
  student: Student,
  message: string
): Promise<boolean> {
  const entity = await safeResolveInputEntity(
    client,
    getStudentTelegramTargets(student)
  );

  if (!entity) {
    console.warn("telegram reply skipped because student entity is unresolved", {
      studentId: student.id,
      telegramId: student.telegram_id ?? null,
      telegramUsername: student.telegram_username ?? null,
    });
    return false;
  }

  try {
    await client.sendMessage(entity, { message });
    return true;
  } catch (error) {
    console.warn("telegram reply send failed; message skipped", {
      studentId: student.id,
      error: getErrorMessage(error),
    });
    return false;
  }
}

function markTelegramMessageProcessed(
  rowId: number,
  studentId: number | null
): void {
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
  console.log("message marked processed", {
    telegramMessageRowId: rowId,
    studentId,
  });
}

function markTelegramMessageError(rowId: number, error: unknown): void {
  const errorMessage = getErrorMessage(error);

  db.prepare(
    `
      UPDATE telegram_messages
      SET processed_at = datetime('now'),
          processing_status = 'error',
          error = ?
      WHERE id = ?
    `
  ).run(errorMessage, rowId);
  console.log("message marked error", {
    telegramMessageRowId: rowId,
    error: errorMessage,
  });
}

function isStaleProcessingMessage(storedMessage: StoredTelegramMessage): boolean {
  if (storedMessage.processing_status !== "processing") {
    return false;
  }

  const referenceTime = Date.parse(
    storedMessage.processed_at ?? storedMessage.created_at
  );

  return (
    Number.isNaN(referenceTime) ||
    Date.now() - referenceTime > staleProcessingMessageMs
  );
}

function storedMessageAlreadyRepresentsPdf(
  storedMessage: StoredTelegramMessage
): boolean {
  return (
    storedMessage.has_media === 1 &&
    (storedMessage.media_type === "application/pdf" ||
      storedMessage.media_type?.toLowerCase().endsWith(".pdf") === true)
  );
}

function refreshStoredMessageMedia(
  rowId: number,
  message: NewMessageEvent["message"],
  document: Api.Document | undefined
): void {
  db.prepare(
    `
      UPDATE telegram_messages
      SET has_media = ?,
          media_type = ?,
          text = COALESCE(?, text)
      WHERE id = ?
    `
  ).run(
    message.media ? 1 : 0,
    document ? document.mimeType : message.media?.className ?? null,
    message.message ?? null,
    rowId
  );
}

async function processTelegramMessageUnlocked(
  client: TelegramClient,
  message: NewMessageEvent["message"],
  source: ProcessingSource
): Promise<ProcessingAction> {
  const document = getMessageDocument(message);
  const messageText = message.message ?? "";
  const mediaClassName = message.media?.className ?? null;

  console.log("Incoming Telegram message debug:", {
    senderId: message.senderId?.toString() ?? null,
    hasText: messageText.length > 0,
    textLength: messageText.length,
    text: messageText || null,
    hasMedia: Boolean(message.media),
    mediaClassName,
    hasDocument: Boolean(document),
    documentMimeType: document?.mimeType ?? null,
    documentFilename: document ? getDocumentFilename(document) ?? null : null,
  });

  if (message.out) {
    return "ignored";
  }

  const senderTelegramId = message.senderId?.toString();
  const chatId = message.chatId?.toString() ?? senderTelegramId;

  if (!senderTelegramId || !chatId) {
    return "ignored";
  }

  const messageType = getMessageType(message, document);
  const messageDate = new Date(message.date * 1000).toISOString();
  db.prepare(
    `
      INSERT OR IGNORE INTO telegram_messages (
        telegram_chat_id,
        telegram_message_id,
        sender_id,
        message_date,
        sender,
        text,
        sent_at,
        has_media,
        media_type,
        processing_status,
        created_at
      )
      VALUES (?, ?, ?, ?, 'student', ?, ?, ?, ?, 'pending', datetime('now'))
    `
  ).run(
    chatId,
    message.id.toString(),
    senderTelegramId,
    messageDate,
    message.message ?? null,
    messageDate,
    message.media ? 1 : 0,
    document ? document.mimeType : message.media?.className ?? null
  );

  const storedMessage = db
    .prepare(
      `
        SELECT id, processing_status, has_media, media_type, processed_at, created_at
        FROM telegram_messages
        WHERE telegram_chat_id = ?
          AND telegram_message_id = ?
      `
    )
    .get(chatId, message.id.toString()) as StoredTelegramMessage;

  console.log("existing telegram message found with status", {
    source,
    chat_id: chatId,
    message_id: message.id.toString(),
    sender_id: senderTelegramId,
    message_type: messageType,
    telegramMessageRowId: storedMessage.id,
    processing_status: storedMessage.processing_status,
    processed_at: storedMessage.processed_at,
    media_type: storedMessage.media_type,
  });

  if (isStaleProcessingMessage(storedMessage)) {
    console.log("stale processing message detected", {
      source,
      chat_id: chatId,
      message_id: message.id.toString(),
      sender_id: senderTelegramId,
      message_type: messageType,
      telegramMessageRowId: storedMessage.id,
      created_at: storedMessage.created_at,
      processed_at: storedMessage.processed_at,
    });

    db.prepare(
      `
        UPDATE telegram_messages
        SET processing_status = 'pending',
            processed_at = NULL,
            error = 'stale processing message will be retried'
        WHERE id = ?
          AND processing_status = 'processing'
      `
    ).run(storedMessage.id);
    storedMessage.processing_status = "pending";
  }

  if (storedMessage.processing_status === "processed") {
    const currentMessageIsPdf = messageType === "pdf";

    if (
      currentMessageIsPdf &&
      !storedMessageAlreadyRepresentsPdf(storedMessage)
    ) {
      refreshStoredMessageMedia(storedMessage.id, message, document);
      db.prepare(
        `
          UPDATE telegram_messages
          SET processing_status = 'pending',
              processed_at = NULL,
              error = NULL
          WHERE id = ?
        `
      ).run(storedMessage.id);

      console.log("processed message re-opened because PDF media is now available", {
        source,
        chat_id: chatId,
        message_id: message.id.toString(),
        sender_id: senderTelegramId,
        previous_media_type: storedMessage.media_type,
      });
    } else {
      console.log("duplicate message skipped", {
        source,
        chat_id: chatId,
        message_id: message.id.toString(),
        sender_id: senderTelegramId,
        message_type: messageType,
        action: "duplicate",
        processing_status: storedMessage.processing_status,
      });
      return "duplicate";
    }
  }

  if (storedMessage.processing_status === "error") {
    console.log("duplicate message skipped", {
      source,
      chat_id: chatId,
      message_id: message.id.toString(),
      sender_id: senderTelegramId,
      message_type: messageType,
      action: "duplicate",
      processing_status: storedMessage.processing_status,
    });
    return "duplicate";
  }

  if (storedMessage.processing_status === "processing") {
    console.log("processing skipped because status is processing and not stale", {
      source,
      chat_id: chatId,
      message_id: message.id.toString(),
      sender_id: senderTelegramId,
      message_type: messageType,
      telegramMessageRowId: storedMessage.id,
      processed_at: storedMessage.processed_at,
      created_at: storedMessage.created_at,
    });
    return "duplicate";
  }

  const claimResult = db
    .prepare(
      `
        UPDATE telegram_messages
        SET processing_status = 'processing',
            processed_at = datetime('now')
        WHERE id = ?
          AND (
            processing_status IS NULL
            OR processing_status = 'pending'
          )
      `
    )
    .run(storedMessage.id);

  if (claimResult.changes === 0) {
    console.log("duplicate message skipped", {
      source,
      chat_id: chatId,
      message_id: message.id.toString(),
      sender_id: senderTelegramId,
      message_type: messageType,
      action: "duplicate",
      processing_status: storedMessage.processing_status,
    });
    return "duplicate";
  }

  refreshStoredMessageMedia(storedMessage.id, message, document);

  const student = findStudentByTelegramId(senderTelegramId);

  if (!student) {
    console.log("No matching student", {
      senderId: senderTelegramId,
    });
    markTelegramMessageProcessed(storedMessage.id, null);
    return "ignored";
  }

  console.log(`Incoming message from student ${student.id}`);

  if (document) {
    if (messageType === "pdf") {
      console.log("new pdf message, starting receipt flow", {
        source,
        chat_id: chatId,
        message_id: message.id.toString(),
        sender_id: senderTelegramId,
        studentId: student.id,
      });
    }

    try {
      const action = await handlePdfReceipt(
        client,
        message,
        student,
        document,
        storedMessage.id
      );
      markTelegramMessageProcessed(storedMessage.id, student.id);
      console.log("Processed Telegram message", {
        source,
        chat_id: chatId,
        message_id: message.id.toString(),
        sender_id: senderTelegramId,
        message_type: messageType,
        action,
      });
      return action;
    } catch (error) {
      markTelegramMessageError(storedMessage.id, error);
      console.error("PDF receipt flow failed; message marked error", {
        source,
        chat_id: chatId,
        message_id: message.id.toString(),
        sender_id: senderTelegramId,
        message_type: messageType,
        studentId: student.id,
        error: getErrorMessage(error),
      });
      return "ignored";
    } finally {
      console.log("PDF receipt flow finished", {
        source,
        chat_id: chatId,
        message_id: message.id.toString(),
        sender_id: senderTelegramId,
        message_type: messageType,
        studentId: student.id,
      });
    }
  }

  const text = message.message?.trim() ?? "";
  const lesson = findActiveScheduledRemindedLesson(student.id);

  if (!lesson) {
    const fallbackIntent = parseStudentReplyIntent(text);
    console.log("Student reply lesson selection", {
      sender_id: senderTelegramId,
      student_id: student.id,
      reply_text: text,
      selected_lesson_id: null,
      selected_lesson_start_time: null,
      selected_lesson_status: null,
      selection_reason: "no_active_scheduled_reminded_lesson",
    });

    if (fallbackIntent === "ready" || fallbackIntent === "cancel") {
      await safelySendStudentMessage(
        client,
        student,
        "Я получил ответ, но не нашёл активный урок для подтверждения. Напиши Бараа напрямую."
      );
    }

    console.log("message ignored as unrelated: no active reminded lesson", {
      studentId: student.id,
      messageType,
    });
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "ignored";
  }

  console.log("Student reply lesson selection", {
    sender_id: senderTelegramId,
    student_id: student.id,
    reply_text: text,
    selected_lesson_id: lesson.id,
    selected_lesson_start_time: lesson.start_time,
    selected_lesson_status: lesson.status,
    selection_reason: "active_scheduled_reminded_lesson",
  });

  const classification = classifyStudentTextForLesson(lesson, text);
  let intent: StudentReplyIntent = classification.intent;
  const messageState = classification.state;

  if (intent === "ready" || intent === "cancel") {
    console.log(
      intent === "ready"
        ? "message parsed as ready"
        : "message parsed as cancellation request",
      {
        studentId: student.id,
        lessonId: lesson.id,
        messageState,
        intent,
        confidence: 1,
        reason: "deterministic rule match",
      }
    );
  }

  console.log("Parsed student reply intent", {
    studentId: student.id,
    lessonId: lesson.id,
    messageState,
    intent,
  });

  if (intent === "cancellation_reason") {
    db.prepare(
      `
        UPDATE lessons
        SET awaiting_cancellation_reason = 0,
            cancellation_source = 'student',
            cancellation_reason = ?,
            cancellation_requested_at = COALESCE(cancellation_requested_at, datetime('now')),
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(text, lesson.id);

    await safelySendStudentMessage(
      client,
      student,
      "Спасибо, я получил причину. Я посмотрю и отвечу вручную."
    );
    console.log("message saved as cancellation reason", {
      lessonId: lesson.id,
      studentId: student.id,
    });
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "cancellation_reason";
  }

  if (
    intent === "unknown" &&
    classification.shouldSendUnknownReminderReply
  ) {
    try {
      const aiResult = await analyzeStudentReplyIntent({
        text,
        studentName: student.name_ru ?? student.name_ar ?? undefined,
        lessonStartTime: lesson.start_time,
      });

      console.log("Student reply parsed by AI", {
        studentId: student.id,
        lessonId: lesson.id,
        intent: aiResult.intent,
        confidence: aiResult.confidence,
        reason: aiResult.reason,
      });

      if (
        aiResult.confidence >= minimumStudentReplyAiConfidence &&
        (aiResult.intent === "ready" || aiResult.intent === "cancel")
      ) {
        intent = aiResult.intent;
      }
    } catch (error) {
      console.error("Student reply AI parsing failed", {
        studentId: student.id,
        lessonId: lesson.id,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }

    if (intent === "unknown") {
      await safelySendStudentMessage(
        client,
        student,
        studentReplyClarificationMessage
      );
      console.log("unknown reminder reply sent", {
        studentId: student.id,
        lessonId: lesson.id,
        text,
      });
      markTelegramMessageProcessed(storedMessage.id, student.id);
      return "ignored";
    }
  }

  if (intent === "unknown") {
    console.log(
      messageState === "awaiting_reminder_response"
        ? "message ignored as unrelated during pending reminder"
        : "skipped unknown reply because no active pending reminder",
      {
        studentId: student.id,
        lessonId: lesson.id,
        messageState,
        text,
      }
    );
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "ignored";
  }

  if (intent === "ready") {
    if (
      !isAwaitingReminderResponse(lesson) &&
      lesson.student_response === "ready"
    ) {
      console.log("message parsed as ready; duplicate ready ignored", {
        studentId: student.id,
        lessonId: lesson.id,
      });
      markTelegramMessageProcessed(storedMessage.id, student.id);
      return "ignored";
    }

    if (isLessonCancelledStatus(lesson.status)) {
      await safelySendStudentMessage(
        client,
        student,
        "Урок уже отмечен как отменённый. Если нужно восстановить урок, напиши преподавателю напрямую."
      );

      console.log(`Cancelled lesson ${lesson.id} kept unchanged after ready reply`);
      markTelegramMessageProcessed(storedMessage.id, student.id);
      return "ignored";
    }

    db.prepare(
      `
        UPDATE lessons
        SET status = 'confirmed',
            student_response = 'ready',
            student_response_at = datetime('now'),
            awaiting_cancellation_reason = 0,
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(lesson.id);

    await safelySendStudentMessage(
      client,
      student,
      "Отлично, до встречи на уроке ✅"
    );

    console.log(`Lesson ${lesson.id} confirmed`);
    const payment = db
      .prepare("SELECT id FROM payments WHERE lesson_id = ?")
      .get(lesson.id) as { id: number } | undefined;
    console.log("Listener is still running, waiting for PDF receipt", {
      lessonId: lesson.id,
      paymentId: payment?.id ?? null,
    });
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "confirmed_lesson";
  }

  if (isLessonCancelledStatus(lesson.status)) {
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "ignored";
  }

  const lessonStartTime = Date.parse(lesson.start_time);
  const hoursUntilLesson = (lessonStartTime - Date.now()) / (60 * 60 * 1000);

  if (hoursUntilLesson <= cancellationDeadlineHours) {
    const cancellationReason = extractCancellationReasonFromCancellationText(text);

    db.prepare(
      `
        UPDATE lessons
        SET awaiting_cancellation_reason = ?,
            student_response = 'not_ready',
            student_response_at = datetime('now'),
            cancellation_source = 'student',
            cancellation_reason = COALESCE(?, cancellation_reason),
            cancellation_requested_at = COALESCE(cancellation_requested_at, datetime('now')),
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(cancellationReason ? 0 : 1, cancellationReason, lesson.id);

    await safelySendStudentMessage(
      client,
      student,
      cancellationReason
        ? "Спасибо, я получил причину. Я посмотрю и отвечу вручную."
        : "К сожалению, я не могу автоматически отменить урок менее чем за 10 часов до начала.\n\nНапиши, пожалуйста, причину здесь — я посмотрю и отвечу вручную."
    );

    console.log("Cancellation blocked because less than 10 hours remain", {
      lessonId: lesson.id,
      studentId: student.id,
      action: "message parsed as cancellation request",
      awaitingCancellationReason: cancellationReason ? 0 : 1,
    });
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "ignored";
  }

  db.prepare(
    `
      UPDATE lessons
      SET status = 'cancelled',
          student_response = 'not_ready',
          student_response_at = datetime('now'),
          cancellation_source = 'student',
          awaiting_cancellation_reason = 0,
          cancellation_requested_at = COALESCE(cancellation_requested_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `
  ).run(lesson.id);

  await safelySendStudentMessage(
    client,
    student,
    "Понял, отмену урока зафиксировал."
  );

  console.log("message parsed as cancellation request; lesson cancelled", {
    lessonId: lesson.id,
    studentId: student.id,
  });
  markTelegramMessageProcessed(storedMessage.id, student.id);
  return "cancelled_lesson";
}

async function processTelegramMessage(
  client: TelegramClient,
  message: NewMessageEvent["message"],
  source: ProcessingSource
): Promise<ProcessingAction> {
  const chatId = message.chatId?.toString();
  const messageId = message.id.toString();

  if (!chatId) {
    return processTelegramMessageUnlocked(client, message, source);
  }

  const lockKey = `${chatId}:${messageId}`;

  if (activeTelegramMessageLocks.has(lockKey)) {
    console.log("processing skipped because another handler is active", {
      source,
      chat_id: chatId,
      message_id: messageId,
    });
    return "duplicate";
  }

  activeTelegramMessageLocks.add(lockKey);

  try {
    return await processTelegramMessageUnlocked(client, message, source);
  } finally {
    activeTelegramMessageLocks.delete(lockKey);
  }
}

async function safelyProcessTelegramMessage(
  client: TelegramClient,
  message: NewMessageEvent["message"],
  source: ProcessingSource
): Promise<ProcessingAction> {
  try {
    const action = await processTelegramMessage(client, message, source);
    if (action !== "duplicate") {
      const document = getMessageDocument(message);
      console.log("Processed Telegram message", {
        source,
        chat_id: message.chatId?.toString() ?? null,
        message_id: message.id.toString(),
        sender_id: message.senderId?.toString() ?? null,
        message_type: getMessageType(message, document),
        action,
      });
    }
    return action;
  } catch (error) {
    const chatId = message.chatId?.toString();
    if (chatId) {
      const row = db
        .prepare(
          `
            SELECT id
            FROM telegram_messages
            WHERE telegram_chat_id = ?
              AND telegram_message_id = ?
          `
        )
        .get(chatId, message.id.toString()) as { id: number } | undefined;

      if (row) {
        markTelegramMessageError(row.id, error);
      }
    }

    console.error("Failed to process Telegram message:", {
      source,
      message_id: message.id.toString(),
      error: error instanceof Error ? error.message : "unknown error",
    });
    return "ignored";
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function startTelegramListener(): Promise<void> {
  let activeClient: TelegramClient | null = null;
  let generation = 0;
  let lastReceivedMessageAt: string | null = null;
  let stopping = false;
  let activeHealthTimer: NodeJS.Timeout | null = null;
  let activePollingTimer: NodeJS.Timeout | null = null;
  let resolveCurrentGeneration: (() => void) | null = null;
  let lastPolledAt: string | null = null;
  let lastPollingError: string | null = null;
  let processedMessageCount = 0;
  let skippedDuplicateCount = 0;
  let isPolling = false;

  const stopListener = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      return;
    }

    stopping = true;
    console.log("telegramListener stopped by signal", {
      signal,
      pid: process.pid,
    });

    if (activeHealthTimer) {
      clearInterval(activeHealthTimer);
      activeHealthTimer = null;
    }
    if (activePollingTimer) {
      clearInterval(activePollingTimer);
      activePollingTimer = null;
    }

    if (activeClient) {
      await activeClient.disconnect();
    }

    resolveCurrentGeneration?.();
  };

  process.once("SIGINT", () => {
    void stopListener("SIGINT");
  });
  process.once("SIGTERM", () => {
    void stopListener("SIGTERM");
  });

  console.log("Telegram listener started.");

  while (!stopping) {
    generation += 1;
    console.log("telegramListener starting connection attempt", {
      pid: process.pid,
      generation,
    });

    try {
      const client = await getTelegramClient("telegramListener");
      activeClient = client;
      await client.getMe();
      console.log("telegramListener Telegram client verified", {
        pid: process.pid,
        generation,
      });

      client.addEventHandler(
        (event) => {
          lastReceivedMessageAt = new Date().toISOString();

          void safelyProcessTelegramMessage(client, event.message, "event").then(
            (action) => {
              if (action === "duplicate") {
                skippedDuplicateCount += 1;
              } else {
                processedMessageCount += 1;
              }
            }
          ).catch((error) => {
            console.error("Failed to handle Telegram message:", error);
          });
        },
        new NewMessage({ incoming: true })
      );
      console.log("telegramListener event handler attached", {
        pid: process.pid,
        generation,
      });

      const pollOnce = async (): Promise<void> => {
        if (isPolling) {
          console.log(
            "telegramListener polling skipped because previous poll is still running"
          );
          return;
        }

        isPolling = true;
        try {
          const students = db
            .prepare(
              `
                SELECT telegram_id, telegram_username
                FROM students
                WHERE is_active = 1
                  AND (
                    (telegram_id IS NOT NULL AND telegram_id != '')
                    OR (telegram_username IS NOT NULL AND telegram_username != '')
                  )
              `
            )
            .all() as Array<{
            telegram_id: string | null;
            telegram_username: string | null;
          }>;

          for (const student of students) {
            const targets = [student.telegram_id, student.telegram_username];
            const target = await safeResolveInputEntity(client, targets);

            if (!target) {
              continue;
            }

            let messages: Awaited<ReturnType<TelegramClient["getMessages"]>>;

            try {
              messages = await client.getMessages(target, {
                limit: pollingLimit,
              });
            } catch (error) {
              const errorMessage = getErrorMessage(error);

              if (isTelegramEntityResolveError(error)) {
                console.warn("telegram entity resolve failed; message skipped", {
                  telegramId: student.telegram_id,
                  telegramUsername: student.telegram_username,
                  error: errorMessage,
                });
              } else {
                console.warn("telegram polling target failed; target skipped", {
                  telegramId: student.telegram_id,
                  telegramUsername: student.telegram_username,
                  error: errorMessage,
                });
              }
              continue;
            }

            for (const message of [...messages].reverse()) {
              try {
                const action = await safelyProcessTelegramMessage(
                  client,
                  message,
                  "polling"
                );
                if (action === "duplicate") {
                  skippedDuplicateCount += 1;
                } else {
                  processedMessageCount += 1;
                }
              } catch (error) {
                console.warn("telegram polling message failed; message skipped", {
                  telegramId: student.telegram_id,
                  telegramUsername: student.telegram_username,
                  messageId: message.id.toString(),
                  error: getErrorMessage(error),
                });
              }
            }
          }

          lastPolledAt = new Date().toISOString();
          lastPollingError = null;
        } catch (error) {
          lastPollingError =
            error instanceof Error ? error.message : "unknown error";
          console.error("telegramListener polling failed", {
            error: lastPollingError,
          });
        } finally {
          isPolling = false;
        }
      };

      if (pollingEnabled) {
        await pollOnce();
        activePollingTimer = setInterval(() => {
          void pollOnce();
        }, pollingIntervalMs);
      } else {
        console.log("telegramListener polling disabled", {
          pid: process.pid,
          generation,
        });
      }
      console.log("telegramListener ready to receive messages", {
        pid: process.pid,
        generation,
      });

      let failedHealthChecks = 0;

      await new Promise<void>((resolve) => {
        resolveCurrentGeneration = resolve;

        activeHealthTimer = setInterval(() => {
          void (async () => {
            try {
              await client.getMe();
              failedHealthChecks = 0;

              console.log("telegramListener heartbeat", {
                pid: process.pid,
                generation,
                timestamp: new Date().toISOString(),
                lastReceivedMessageAt,
                lastPolledAt,
                lastPollingError,
                processedMessageCount,
                skippedDuplicateCount,
              });
            } catch (error) {
              failedHealthChecks += 1;
              console.error("telegramListener health check failed", {
                pid: process.pid,
                generation,
                failedHealthChecks,
                error: error instanceof Error ? error.message : "unknown error",
              });

              if (failedHealthChecks >= 2) {
                if (activeHealthTimer) {
                  clearInterval(activeHealthTimer);
                  activeHealthTimer = null;
                }
                if (activePollingTimer) {
                  clearInterval(activePollingTimer);
                  activePollingTimer = null;
                }

                resolve();
              }
            }
          })();
        }, healthCheckIntervalMs);
      });

      resolveCurrentGeneration = null;

      if (stopping) {
        break;
      }

      await client.disconnect();
      activeClient = null;
      console.error("telegramListener connection unhealthy, reconnecting", {
        pid: process.pid,
        generation,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        "telegramListener reconnect failed",
        error instanceof Error ? error.message : "unknown error"
      );
      activeClient = null;
    }

    if (!stopping) {
      await sleep(reconnectDelayMs);
    }
  }
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
