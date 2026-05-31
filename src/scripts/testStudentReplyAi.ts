import "dotenv/config";
import { analyzeStudentReplyIntent } from "../services/studentReplyAiService";

async function main() {
  const text = process.argv.slice(2).join(" ").trim();

  if (!text) {
    console.error('Usage: npm run test:reply-ai -- "لا أستطيع، لدي جامعة صباحا"');
    process.exit(1);
  }

  const result = await analyzeStudentReplyIntent({ text });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Student reply AI test failed:");
  console.error(error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
