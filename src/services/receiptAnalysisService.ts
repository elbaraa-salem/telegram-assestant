import "dotenv/config";
import fs from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import { db } from "../database/db";

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
const model = process.env.OPENROUTER_MODEL ?? "";

type PaymentRow = {
  id: number;
  receipt_file_path: string | null;
};

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

export type ReceiptAiResult = {
  is_payment_receipt: boolean;
  payment_confirmed: boolean | null;
  amount: number | null;
  currency: string | null;
  payment_date: string | null;
  document_number: string | null;
  operation_id: string | null;
  recipient: string | null;
  sender: string | null;
  confidence: number | null;
  reason: string;
};

export type ReceiptAnalysisResult = {
  paymentId: number;
  receiptFilePath: string;
  extractedTextLength: number;
  parsedAiResult: ReceiptAiResult;
};

export async function extractTextFromPdf(pathToPdf: string): Promise<string> {
  const data = await fs.readFile(pathToPdf);
  const parser = new PDFParse({ data });

  try {
    const result = await parser.getText();
    return result.text.trim();
  } finally {
    await parser.destroy();
  }
}

function buildPrompt(receiptText: string): string {
  return `Analyze this payment receipt text and return JSON only.

The receipt text may be Russian.
"Выполнено" and "Операция выполнена" mean the operation was completed.
"₽" means RUB.
Convert dates from DD.MM.YYYY to YYYY-MM-DD.
If amount, date, or status cannot be clearly found, use null where appropriate and lower confidence.
Extract stable receipt identifiers when present:
- document_number, for example M70272139777 or document/check/receipt number
- operation_id, transaction id, authorization id, or operation number
- recipient and sender names when present

Amount extraction rules:
- Prefer the amount after labels: "Итого", "Сумма перевода", "Сумма операции", "Оплачено".
- Ignore commission, cashback, card/account numbers, phone numbers, bank account fragments, MCC, timestamps, document numbers, correspondent account numbers.
- Do not infer amount from random numeric fragments.
- If multiple possible payment amounts exist, choose the final paid/total amount.
- If uncertain, return payment_confirmed=false or confidence below 0.8.
Return JSON only.
Do not use markdown.
Do not add explanation outside JSON.

Use exactly this JSON shape:
{
  "is_payment_receipt": true,
  "payment_confirmed": true,
  "amount": 5000,
  "currency": "RUB",
  "payment_date": "2026-05-15",
  "document_number": "M70272139777",
  "operation_id": null,
  "recipient": "Recipient name",
  "sender": "Sender name",
  "confidence": 0.92,
  "reason": "..."
}

Receipt text:
${receiptText}`;
}

export async function analyzeReceiptText(receiptText: string): Promise<ReceiptAiResult> {
  if (!apiKey || !model) {
    throw new Error("Missing OPENROUTER_API_KEY or OPENROUTER_MODEL");
  }

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: buildPrompt(receiptText),
          },
        ],
        temperature: 0,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`OpenRouter request failed with HTTP ${response.status}`);
  }

  const data = (await response.json()) as OpenRouterResponse;
  const rawAiResponse = data.choices?.[0]?.message?.content?.trim() ?? "";

  try {
    return JSON.parse(rawAiResponse) as ReceiptAiResult;
  } catch (error) {
    throw new Error(
      `Failed to parse AI response as JSON: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
}

export async function analyzeAndSavePaymentReceipt(
  paymentId: number
): Promise<ReceiptAnalysisResult> {
  const payment = db
    .prepare(
      `
        SELECT id, receipt_file_path
        FROM payments
        WHERE id = ?
      `
    )
    .get(paymentId) as PaymentRow | undefined;

  if (!payment) {
    throw new Error(`Payment ${paymentId} not found`);
  }

  if (!payment.receipt_file_path) {
    throw new Error(`Payment ${paymentId} has no receipt_file_path`);
  }

  const extractedText = await extractTextFromPdf(payment.receipt_file_path);
  const parsedAiResult = await analyzeReceiptText(extractedText);

  db.prepare(
    `
      UPDATE payments
      SET receipt_text = ?,
          ai_amount = ?,
          ai_currency = ?,
          ai_payment_date = ?,
          ai_confidence = ?,
          ai_raw_result = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `
  ).run(
    extractedText,
    parsedAiResult.amount,
    parsedAiResult.currency,
    parsedAiResult.payment_date,
    parsedAiResult.confidence,
    JSON.stringify(parsedAiResult),
    paymentId
  );

  return {
    paymentId,
    receiptFilePath: payment.receipt_file_path,
    extractedTextLength: extractedText.length,
    parsedAiResult,
  };
}
