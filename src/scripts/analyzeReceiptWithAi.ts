import "dotenv/config";
import fs from "node:fs/promises";
import { PDFParse } from "pdf-parse";

const filePath = process.argv[2];
const apiKey = process.env.OPENROUTER_API_KEY ?? "";
const model = process.env.OPENROUTER_MODEL ?? "";

if (!filePath) {
  console.error("Usage: tsx src/scripts/analyzeReceiptWithAi.ts <pdf-path>");
  process.exit(1);
}

if (!apiKey || !model) {
  console.error("Missing OPENROUTER_API_KEY or OPENROUTER_MODEL");
  process.exit(1);
}

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

async function extractTextFromPdf(pathToPdf: string): Promise<string> {
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
Return JSON only.
Do not use markdown.
Do not add explanation outside JSON.

Use exactly this JSON shape:
{
  "is_payment_receipt": true,
  "payment_confirmed": true,
  "amount": 300,
  "currency": "RUB",
  "payment_date": "2026-05-15",
  "confidence": 0.92,
  "reason": "..."
}

Receipt text:
${receiptText}`;
}

async function main() {
  const extractedText = await extractTextFromPdf(filePath);

  console.log(`Extracted text length: ${extractedText.length}`);

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
            content: buildPrompt(extractedText),
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

  console.log("Raw AI response:");
  console.log(rawAiResponse);

  try {
    const parsedJson = JSON.parse(rawAiResponse) as unknown;
    console.log("Parsed JSON object:");
    console.log(parsedJson);
  } catch (error) {
    console.error("Failed to parse AI response as JSON.");
    console.error("Raw AI response:");
    console.error(rawAiResponse);
    throw error;
  }
}

main().catch((error) => {
  console.error("Receipt AI analysis failed:");
  console.error(error);
  process.exit(1);
});
