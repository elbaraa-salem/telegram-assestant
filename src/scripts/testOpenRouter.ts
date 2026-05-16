import "dotenv/config";

const apiKey = process.env.OPENROUTER_API_KEY ?? "";
const model = process.env.OPENROUTER_MODEL ?? "";

if (!apiKey || !model) {
  console.error(`Model used: ${model || "missing"}`);
  console.error("Response text:");
  console.error("Failure: missing OPENROUTER_API_KEY or OPENROUTER_MODEL");
  process.exit(1);
}

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

async function main() {
  try {
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
              content: "Reply with only the word OK",
            },
          ],
          temperature: 0,
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    const responseText = data.choices?.[0]?.message?.content?.trim() ?? "";

    console.log(`Model used: ${model}`);
    console.log(`Response text: ${responseText}`);
    console.log("Success");
  } catch (error) {
    console.log(`Model used: ${model}`);
    console.log("Response text:");
    console.log(`Failure: ${error instanceof Error ? error.message : "Unknown error"}`);
    process.exit(1);
  }
}

void main();
