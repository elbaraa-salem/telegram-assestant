import "dotenv/config";
import { db } from "../database/db";

const defaultManageSpendBotUsername = "@ManageSpendBot";

type ManageSpendPaymentRow = {
  id: number;
  amount: number | null;
  currency: string;
  status: string;
  manage_spend_notified_at: string | null;
  name_ru: string | null;
  lesson_price_amount: number | null;
  lesson_price_currency: string | null;
};

export type ManageSpendTelegramSender = (
  username: string,
  message: string
) => Promise<string | null>;

let telegramSenderOverride: ManageSpendTelegramSender | null = null;

export function setManageSpendTelegramSenderForTests(
  sender: ManageSpendTelegramSender | null
): void {
  telegramSenderOverride = sender;
}

function getManageSpendBotUsername(): string {
  const configured =
    process.env.MANAGE_SPEND_BOT_USERNAME?.trim() ||
    defaultManageSpendBotUsername;

  return configured.startsWith("@") ? configured : `@${configured}`;
}

function notificationsEnabled(): boolean {
  return (
    String(process.env.MANAGE_SPEND_BOT_NOTIFICATIONS_ENABLED ?? "true")
      .trim()
      .toLowerCase() === "true"
  );
}

function formatPaymentAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : String(amount);
}

function getLessonWord(count: number): string {
  const absoluteCount = Math.abs(count);
  const lastTwoDigits = absoluteCount % 100;
  const lastDigit = absoluteCount % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return "занятий";
  }

  if (lastDigit === 1) {
    return "занятие";
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return "занятия";
  }

  return "занятий";
}

export function buildManageSpendPaymentMessage(input: {
  amount: number;
  currency: string;
  studentNameRu: string;
  lessonPriceAmount: number;
  lessonPriceCurrency: string;
}): string {
  const studentName = input.studentNameRu.trim() || "учеником";
  const amountText = `${formatPaymentAmount(input.amount)} ${input.currency}`;
  const canUseLessonCount =
    input.lessonPriceAmount > 0 &&
    input.lessonPriceCurrency === input.currency &&
    input.amount % input.lessonPriceAmount === 0;

  if (!canUseLessonCount) {
    return `получил ${amountText} за занятия с ${studentName}`;
  }

  const lessonCount = input.amount / input.lessonPriceAmount;

  if (lessonCount === 1) {
    return `получил ${amountText} за занятие с ${studentName}`;
  }

  return `получил ${amountText} за ${lessonCount} ${getLessonWord(
    lessonCount
  )} с ${studentName}`;
}

async function sendTelegramMessage(
  username: string,
  message: string
): Promise<string | null> {
  if (telegramSenderOverride) {
    return telegramSenderOverride(username, message);
  }

  const { getTelegramClient } = await import("./telegramClient");
  const client = await getTelegramClient("manageSpendBotNotifier", {
    sendOnly: true,
  });

  try {
    const sentMessage = (await client.sendMessage(username, {
      message,
    })) as { id?: unknown } | undefined;

    return sentMessage?.id === undefined ? null : String(sentMessage.id);
  } finally {
    await client.disconnect();
    console.log("manageSpendBotNotifier Telegram client disconnected", {
      pid: process.pid,
    });
  }
}

function saveNotificationError(paymentId: number, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);

  db.prepare(
    `
      UPDATE payments
      SET manage_spend_notify_error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `
  ).run(errorMessage, paymentId);
}

export async function notifyManageSpendBotForPayment(
  paymentId: number
): Promise<void> {
  if (!notificationsEnabled()) {
    return;
  }

  console.log("manage spend notification started", { paymentId });

  try {
    const payment = db
      .prepare(
        `
          SELECT
            payments.id,
            payments.amount,
            payments.currency,
            payments.status,
            payments.manage_spend_notified_at,
            students.name_ru,
            students.lesson_price_amount,
            students.lesson_price_currency
          FROM payments
          JOIN students ON students.id = payments.student_id
          WHERE payments.id = ?
        `
      )
      .get(paymentId) as ManageSpendPaymentRow | undefined;

    if (!payment || payment.status !== "confirmed") {
      return;
    }

    if (payment.manage_spend_notified_at) {
      console.log("manage spend notification skipped because already sent", {
        paymentId,
        manageSpendNotifiedAt: payment.manage_spend_notified_at,
      });
      return;
    }

    const amount = Math.max(0, Math.round(payment.amount ?? 0));

    if (amount <= 0) {
      return;
    }

    const claimResult = db
      .prepare(
        `
          UPDATE payments
          SET manage_spend_notify_error = 'sending',
              updated_at = datetime('now')
          WHERE id = ?
            AND manage_spend_notified_at IS NULL
            AND COALESCE(manage_spend_notify_error, '') != 'sending'
        `
      )
      .run(paymentId);

    if (claimResult.changes === 0) {
      const current = db
        .prepare(
          `
            SELECT manage_spend_notified_at
            FROM payments
            WHERE id = ?
          `
        )
        .get(paymentId) as { manage_spend_notified_at: string | null } | undefined;

      if (current?.manage_spend_notified_at) {
        console.log("manage spend notification skipped because already sent", {
          paymentId,
          manageSpendNotifiedAt: current.manage_spend_notified_at,
        });
      }

      return;
    }

    const message = buildManageSpendPaymentMessage({
      amount,
      currency: payment.currency,
      studentNameRu: payment.name_ru ?? "",
      lessonPriceAmount: Math.max(0, Math.round(payment.lesson_price_amount ?? 0)),
      lessonPriceCurrency: payment.lesson_price_currency || payment.currency,
    });
    const username = getManageSpendBotUsername();

    console.log("manage spend message text", {
      paymentId,
      username,
      message,
    });

    const messageId = await sendTelegramMessage(username, message);

    db.prepare(
      `
        UPDATE payments
        SET manage_spend_notified_at = datetime('now'),
            manage_spend_message_id = ?,
            manage_spend_notify_error = NULL,
            updated_at = datetime('now')
        WHERE id = ?
          AND manage_spend_notified_at IS NULL
      `
    ).run(messageId, paymentId);

    console.log("manage spend notification sent", {
      paymentId,
      username,
      messageId,
    });
  } catch (error) {
    console.error("manage spend notification failed", {
      paymentId,
      error: error instanceof Error ? error.message : String(error),
    });

    try {
      saveNotificationError(paymentId, error);
    } catch (saveError) {
      console.error("manage spend notification error save failed", {
        paymentId,
        error: saveError instanceof Error ? saveError.message : String(saveError),
      });
    }
  }
}
