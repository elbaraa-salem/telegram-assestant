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
const pollingIntervalMs = Number(
  process.env.TELEGRAM_LISTENER_POLL_INTERVAL_MS ?? 5_000
);
const pollingLimit = Number(process.env.TELEGRAM_LISTENER_POLL_LIMIT ?? 5);

type Student = {
  id: number;
  telegram_id: string;
  telegram_username?: string | null;
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
  awaiting_cancellation_reason: number;
};

function findNearestRemindedLesson(studentId: number): Lesson | null {
  const now = Date.now();
  const recentCutoff = now - recentLessonWindowHours * 60 * 60 * 1000;

  const lessons = db
    .prepare(
      `
        SELECT id, start_time, status, student_response, awaiting_cancellation_reason
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

function normalizeTelegramUsername(username: string): string {
  const trimmed = username.trim();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function findStudentByTelegramUsername(username: string): Student | undefined {
  return db
    .prepare(
      `
        SELECT id, telegram_id, telegram_username
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
): Promise<"saved_receipt" | "ignored"> {
  if (!isPdfDocument(document)) {
    console.log("Document received but not PDF");
    return "ignored";
  }

  console.log("PDF receipt detected");

  const payment = findPdfReceiptPayment(student.id);

  if (!payment) {
    console.log("PDF received but no pending payment found");
    await message.respond({
      message: "Сейчас я не ожидаю чек об оплате.",
    });
    return "ignored";
  }

  console.log(`Payment found for PDF receipt: ${payment.id}`);

  const receiptsDir = path.join(process.cwd(), "data", "receipts");
  const receiptPath = path.join(receiptsDir, `payment-${payment.id}.pdf`);

  await fs.mkdir(receiptsDir, { recursive: true });
  await message.downloadMedia({ outputFile: receiptPath });
  console.log(`Receipt saved: ${receiptPath}`);

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
  return "saved_receipt";
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
};

type StudentReplyIntent = "ready" | "cancel" | "cancellation_reason" | "unknown";

function normalizeReplyText(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .replace(/[.,!?،؛:;]/g, "")
    .replace(/\s+/g, " ");
}

function parseStudentReplyIntent(text: string): Exclude<StudentReplyIntent, "cancellation_reason"> {
  const normalized = normalizeReplyText(text);
  const cancellationPhrases = new Set([
    "2",
    "нет",
    "не могу",
    "не получится",
    "отмена",
    "отменить",
    "нужно отменить",
    "я не смогу",
    "не готов",
  ]);
  const readyPhrases = new Set([
    "1",
    "да",
    "да я готов",
    "я готов",
    "готов",
    "буду",
    "ок",
    "окей",
    "хорошо",
    "+",
    "yes",
  ]);

  if (
    cancellationPhrases.has(normalized) ||
    normalized.includes("не готов") ||
    normalized.includes("не могу") ||
    normalized.includes("не смогу")
  ) {
    return "cancel";
  }

  if (readyPhrases.has(normalized)) {
    return "ready";
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
}

function markTelegramMessageError(rowId: number, error: unknown): void {
  db.prepare(
    `
      UPDATE telegram_messages
      SET processed_at = datetime('now'),
          processing_status = 'error',
          error = ?
      WHERE id = ?
    `
  ).run(error instanceof Error ? error.message : "unknown error", rowId);
}

async function processTelegramMessage(
  _client: TelegramClient,
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

  const sender = await message.getSender();
  const senderTelegramId = message.senderId?.toString();
  const chatId = message.chatId?.toString();

  if (!sender || !senderTelegramId || !chatId) {
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
        SELECT id, processing_status
        FROM telegram_messages
        WHERE telegram_chat_id = ?
          AND telegram_message_id = ?
      `
    )
    .get(chatId, message.id.toString()) as StoredTelegramMessage;

  if (storedMessage.processing_status === "processed") {
    console.log("Processed Telegram message", {
      source,
      chat_id: chatId,
      message_id: message.id.toString(),
      sender_id: senderTelegramId,
      message_type: messageType,
      action: "duplicate",
    });
    return "duplicate";
  }

  const claimResult = db
    .prepare(
      `
        UPDATE telegram_messages
        SET processing_status = 'processing'
        WHERE id = ?
          AND (
            processing_status IS NULL
            OR processing_status IN ('pending', 'error')
          )
      `
    )
    .run(storedMessage.id);

  if (claimResult.changes === 0) {
    console.log("Processed Telegram message", {
      source,
      chat_id: chatId,
      message_id: message.id.toString(),
      sender_id: senderTelegramId,
      message_type: messageType,
      action: "duplicate",
    });
    return "duplicate";
  }

  let student = findStudentByTelegramId(senderTelegramId);
  const senderUsername =
    sender instanceof Api.User && sender.username
      ? normalizeTelegramUsername(sender.username)
      : null;

  if (!student && senderUsername) {
    student = findStudentByTelegramUsername(senderUsername);

    if (student) {
      db.prepare("UPDATE students SET telegram_id = ? WHERE id = ?").run(
        senderTelegramId,
        student.id
      );
      student.telegram_id = senderTelegramId;

      console.log("Student telegram_id learned from incoming message", {
        studentId: student.id,
        username: senderUsername,
        senderId: senderTelegramId,
      });
    }
  }

  if (!student) {
    console.log("No matching student", {
      senderId: senderTelegramId,
      username: senderUsername,
    });
    markTelegramMessageProcessed(storedMessage.id, null);
    return "ignored";
  }

  console.log(`Incoming message from student ${student.id}`);

  if (document) {
    const action = await handlePdfReceipt(message, student, chatId, document);
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
  }

  const lesson = findNearestRemindedLesson(student.id);

  if (!lesson) {
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "ignored";
  }

  const text = message.message?.trim() ?? "";
  let intent: StudentReplyIntent = parseStudentReplyIntent(text);

  if (intent === "unknown" && lesson.awaiting_cancellation_reason === 1 && text) {
    intent = "cancellation_reason";
  }

  console.log("Parsed student reply intent", {
    studentId: student.id,
    lessonId: lesson.id,
    intent,
  });

  if (intent === "cancellation_reason") {
    db.prepare(
      `
        UPDATE lessons
        SET awaiting_cancellation_reason = 0,
            cancellation_reason = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(text, lesson.id);

    await message.respond({
      message: "Спасибо, я получил причину. Я посмотрю и отвечу вручную.",
    });
    console.log("Cancellation reason saved", {
      lessonId: lesson.id,
      studentId: student.id,
    });
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "cancellation_reason";
  }

  if (intent === "unknown") {
    console.log("Ignored non-command non-PDF message");
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "ignored";
  }

  if (intent === "ready") {
    if (
      lesson.status === "confirmed" &&
      lesson.student_response === "ready"
    ) {
      console.log(`Ignored duplicate ready response for lesson ${lesson.id}`);
      markTelegramMessageProcessed(storedMessage.id, student.id);
      return "ignored";
    }

    if (
      lesson.status === "cancelled_by_student" ||
      lesson.status === "cancelled_by_teacher"
    ) {
      await message.respond({
        message:
          "Урок уже отмечен как отменённый. Если нужно восстановить урок, напиши преподавателю напрямую.",
      });

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
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(lesson.id);

    await message.respond({
      message: "Отлично, до встречи на уроке ✅",
    });

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

  if (
    lesson.status === "cancelled_by_student" ||
    lesson.status === "cancelled_by_teacher"
  ) {
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "ignored";
  }

  const lessonStartTime = Date.parse(lesson.start_time);
  const hoursUntilLesson = (lessonStartTime - Date.now()) / (60 * 60 * 1000);

  if (hoursUntilLesson <= cancellationDeadlineHours) {
    db.prepare(
      `
        UPDATE lessons
        SET awaiting_cancellation_reason = 1,
            cancellation_requested_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `
    ).run(lesson.id);

    await message.respond({
      message:
        "К сожалению, я не могу автоматически отменить урок менее чем за 10 часов до начала.\n\nНапиши, пожалуйста, причину здесь — я посмотрю и отвечу вручную.",
    });

    console.log("Cancellation blocked because less than 10 hours remain", {
      lessonId: lesson.id,
      studentId: student.id,
    });
    markTelegramMessageProcessed(storedMessage.id, student.id);
    return "ignored";
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
  markTelegramMessageProcessed(storedMessage.id, student.id);
  return "cancelled_lesson";
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
            const target =
              student.telegram_id?.trim() ||
              student.telegram_username?.trim().replace(/^@/, "");

            if (!target) {
              continue;
            }

            const messages = await client.getMessages(target, {
              limit: pollingLimit,
            });

            for (const message of [...messages].reverse()) {
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

      await pollOnce();
      activePollingTimer = setInterval(() => {
        void pollOnce();
      }, pollingIntervalMs);
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
