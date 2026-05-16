import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { Api, TelegramClient } from "telegram";
import { db } from "../database/db";
import { getTelegramClient } from "./telegramClient";
import { analyzeAndSavePaymentReceipt } from "./receiptAnalysisService";

const recentLessonWindowHours = 4;
const cancellationDeadlineHours = Number(
  process.env.CANCELLATION_DEADLINE_HOURS ?? 10
);
const reconnectDelayMs = 3_000;
const healthCheckIntervalMs = 60_000;

type Student = {
  id: number;
  telegram_id: string;
};

type PdfReceiptPaymentCandidate = {
  id: number;
  status: string;
  lesson_id: number;
  lesson_status: string;
  student_response: string | null;
  start_time: string;
  receipt_file_path: string | null;
};

type Lesson = {
  id: number;
  start_time: string;
  status: string;
  student_response: string | null;
};

function findNearestRemindedLesson(studentId: number): Lesson | null {
  const now = Date.now();
  const recentCutoff = now - recentLessonWindowHours * 60 * 60 * 1000;

  const lessons = db
    .prepare(
      `
        SELECT id, start_time, status, student_response
        FROM lessons
        WHERE student_id = ?
          AND reminder_sent = 1
          AND status IN (
            'scheduled',
            'confirmed',
            'cancelled_by_student',
            'cancelled_by_teacher'
          )
      `
    )
    .all(studentId) as Lesson[];

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

function saveTelegramMessage(
  studentId: number,
  chatId: string,
  messageId: string,
  text: string,
  sentAt: string
): void {
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
  ).run(studentId, chatId, messageId, text, sentAt);
}

function findStudentByTelegramId(telegramId: string): Student | undefined {
  return db
    .prepare(
      `
        SELECT id, telegram_id
        FROM students
        WHERE telegram_id = ?
      `
    )
    .get(telegramId) as Student | undefined;
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

function findPdfReceiptPayment(studentId: number): PdfReceiptPaymentCandidate | undefined {
  const candidates = db
    .prepare(
      `
        SELECT
          payments.id,
          payments.status,
          payments.lesson_id,
          lessons.status AS lesson_status,
          lessons.student_response,
          lessons.start_time,
          payments.receipt_file_path
        FROM payments
        INNER JOIN lessons ON lessons.id = payments.lesson_id
        WHERE payments.student_id = ?
        ORDER BY lessons.id DESC, payments.id DESC
      `
    )
    .all(studentId) as PdfReceiptPaymentCandidate[];

  console.log(
    "Candidate payments for PDF receipt",
    candidates.map((candidate) => ({
      payment_id: candidate.id,
      payment_status: candidate.status,
      lesson_id: candidate.lesson_id,
      lesson_status: candidate.lesson_status,
      student_response: candidate.student_response,
      start_time: candidate.start_time,
      receipt_file_path: candidate.receipt_file_path,
    }))
  );

  const pendingReceiptStatuses = new Set(["requested", "receipt_received"]);

  return candidates
    .filter((candidate) => pendingReceiptStatuses.has(candidate.status))
    .sort((left, right) => {
      const leftCompleted = left.lesson_status === "completed" ? 1 : 0;
      const rightCompleted = right.lesson_status === "completed" ? 1 : 0;

      if (leftCompleted !== rightCompleted) {
        return rightCompleted - leftCompleted;
      }

      const leftStartTime = Date.parse(left.start_time);
      const rightStartTime = Date.parse(right.start_time);

      if (!Number.isNaN(leftStartTime) && !Number.isNaN(rightStartTime)) {
        if (leftStartTime !== rightStartTime) {
          return rightStartTime - leftStartTime;
        }
      } else if (!Number.isNaN(leftStartTime)) {
        return -1;
      } else if (!Number.isNaN(rightStartTime)) {
        return 1;
      }

      if (left.lesson_id !== right.lesson_id) {
        return right.lesson_id - left.lesson_id;
      }

      return right.id - left.id;
    })[0];
}

async function handlePdfReceipt(
  message: NewMessageEvent["message"],
  student: Student,
  chatId: string,
  document: Api.Document
): Promise<void> {
  if (!isPdfDocument(document)) {
    console.log("Document received but not PDF");
    return;
  }

  console.log("PDF receipt detected");

  const payment = findPdfReceiptPayment(student.id);

  if (!payment) {
    console.log("PDF received but no pending payment found");
    await message.respond({
      message: "Сейчас я не ожидаю чек об оплате.",
    });
    return;
  }

  console.log(`Payment found for PDF receipt: ${payment.id}`);

  const receiptsDir = path.join(process.cwd(), "data", "receipts");
  const receiptPath = path.join(receiptsDir, `payment-${payment.id}.pdf`);

  await fs.mkdir(receiptsDir, { recursive: true });
  await message.downloadMedia({ outputFile: receiptPath });
  console.log(`Receipt saved: ${receiptPath}`);

  saveTelegramMessage(
    student.id,
    chatId,
    message.id.toString(),
    message.message ?? "",
    new Date(message.date * 1000).toISOString()
  );

  db.prepare(
    `
      UPDATE payments
      SET status = 'receipt_received',
          receipt_received_at = datetime('now'),
          telegram_message_id = ?,
          telegram_file_id = ?,
          receipt_file_path = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `
  ).run(
    message.id.toString(),
    document.id.toString(),
    receiptPath,
    payment.id
  );
  console.log("Payment status updated to receipt_received");

  try {
    const analysis = await analyzeAndSavePaymentReceipt(payment.id);
    const result = analysis.parsedAiResult;

    console.log("AI receipt analysis completed", {
      paymentId: payment.id,
      amount: result.amount,
      currency: result.currency,
      payment_date: result.payment_date,
      confidence: result.confidence,
      payment_confirmed: result.payment_confirmed,
    });
  } catch (error) {
    console.error(
      "AI receipt analysis failed",
      error instanceof Error ? error.message : "unknown error"
    );
  }

  await message.respond({
    message: "Чек получен ✅ Я проверю оплату.",
  });

  console.log(`PDF receipt saved for payment ${payment.id}`);
}

async function handleIncomingMessage(event: NewMessageEvent): Promise<void> {
  const message = event.message;
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
    return;
  }

  const sender = await message.getSender();
  const senderTelegramId = message.senderId?.toString();
  const chatId = message.chatId?.toString();

  if (!sender || !senderTelegramId || !chatId) {
    return;
  }

  const student = findStudentByTelegramId(senderTelegramId);

  if (!student) {
    console.log("No matching student");
    return;
  }

  console.log(`Incoming message from student ${student.id}`);

  if (document) {
    await handlePdfReceipt(message, student, chatId, document);
    return;
  }

  const text = message.message?.trim();

  if (text !== "1" && text !== "2") {
    console.log("Ignored non-command non-PDF message");
    return;
  }

  const lesson = findNearestRemindedLesson(student.id);

  if (!lesson) {
    return;
  }

  if (text === "1") {
    if (
      lesson.status === "confirmed" &&
      lesson.student_response === "ready"
    ) {
      console.log(`Ignored duplicate ready response for lesson ${lesson.id}`);
      return;
    }

    if (
      lesson.status === "cancelled_by_student" ||
      lesson.status === "cancelled_by_teacher"
    ) {
      saveTelegramMessage(
        student.id,
        chatId,
        message.id.toString(),
        text,
        new Date(message.date * 1000).toISOString()
      );

      await message.respond({
        message:
          "Урок уже отмечен как отменённый. Если нужно восстановить урок, напиши преподавателю напрямую.",
      });

      console.log(`Cancelled lesson ${lesson.id} kept unchanged after ready reply`);
      return;
    }

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

    saveTelegramMessage(
      student.id,
      chatId,
      message.id.toString(),
      text,
      new Date(message.date * 1000).toISOString()
    );

    await message.respond({
      message: "Отлично, до встречи на уроке ✅",
    });

    console.log(`Lesson ${lesson.id} confirmed`);
    return;
  }

  if (
    lesson.status === "cancelled_by_student" ||
    lesson.status === "cancelled_by_teacher"
  ) {
    return;
  }

  const lessonStartTime = Date.parse(lesson.start_time);
  const hoursUntilLesson = (lessonStartTime - Date.now()) / (60 * 60 * 1000);

  saveTelegramMessage(
    student.id,
    chatId,
    message.id.toString(),
    text,
    new Date(message.date * 1000).toISOString()
  );

  if (hoursUntilLesson <= cancellationDeadlineHours) {
    await message.respond({
      message:
        "Извини, я не могу отменить урок менее чем за 10 часов до начала. Напиши преподавателю напрямую.",
    });

    console.log(`Cancellation rejected because deadline passed for lesson ${lesson.id}`);
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

  console.log(`Lesson ${lesson.id} cancelled`);
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
  let resolveCurrentGeneration: (() => void) | null = null;

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

          void handleIncomingMessage(event).catch((error) => {
            console.error("Failed to handle Telegram message:");
            console.error(error);
          });
        },
        new NewMessage({ incoming: true })
      );

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
