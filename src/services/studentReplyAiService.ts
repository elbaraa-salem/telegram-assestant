import "dotenv/config";

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
const model = process.env.OPENROUTER_MODEL ?? "";

export type StudentReplyAiInput = {
  text: string;
  studentName?: string;
  lessonStartTime?: string;
};

export type StudentReplyAiResult = {
  intent: "ready" | "cancel" | "unknown";
  confidence: number;
  reason: string;
  language?: "ar" | "ru" | "en" | "mixed" | "unknown";
};

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

function buildPrompt(input: StudentReplyAiInput): string {
  return `Analyze a student's Telegram reply about an upcoming lesson.

Understand Arabic, Russian, English, and mixed-language replies.
Decide whether the student is ready to attend, wants to cancel/cannot attend, or the message is unknown.
Return JSON only.
Do not include markdown.
Do not add explanation outside JSON.

Classification rules:
- If the student clearly confirms attendance, use "ready".
- If the student says they cannot attend, asks to cancel, says they are busy, or university/work prevents attendance, use "cancel".
- If ambiguous, a question, homework, receipt, payment, unrelated message, or not about attendance, use "unknown".
- Negation has priority: "не готов", "не смогу", "مش هقدر", "لا أستطيع" mean "cancel".
- Do not classify a cancellation reason as ready.

Use exactly this JSON shape:
{
  "intent": "ready",
  "confidence": 0.0,
  "language": "ar",
  "reason": "short explanation"
}

Allowed intent values: "ready", "cancel", "unknown".
Allowed language values: "ar", "ru", "en", "mixed", "unknown".
Confidence must be a number from 0.0 to 1.0.

Context:
Student name: ${input.studentName ?? "unknown"}
Lesson start time: ${input.lessonStartTime ?? "unknown"}

Student reply:
${input.text}`;
}

function normalizeAiResult(value: unknown): StudentReplyAiResult {
  if (!value || typeof value !== "object") {
    throw new Error("AI response JSON is not an object");
  }

  const result = value as {
    intent?: unknown;
    confidence?: unknown;
    language?: unknown;
    reason?: unknown;
  };
  const intent =
    result.intent === "ready" ||
    result.intent === "cancel" ||
    result.intent === "unknown"
      ? result.intent
      : "unknown";
  const confidence =
    typeof result.confidence === "number" && Number.isFinite(result.confidence)
      ? Math.min(1, Math.max(0, result.confidence))
      : 0;
  const language =
    result.language === "ar" ||
    result.language === "ru" ||
    result.language === "en" ||
    result.language === "mixed" ||
    result.language === "unknown"
      ? result.language
      : "unknown";
  const reason =
    typeof result.reason === "string" && result.reason.trim()
      ? result.reason.trim()
      : "No reason returned";

  return {
    intent,
    confidence,
    language,
    reason,
  };
}

export async function analyzeStudentReplyIntent(
  input: StudentReplyAiInput
): Promise<StudentReplyAiResult> {
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
            content: buildPrompt(input),
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
    return normalizeAiResult(JSON.parse(rawAiResponse));
  } catch (error) {
    throw new Error(
      `Failed to parse AI response as JSON: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }
}
