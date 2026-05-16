import { analyzeAndSavePaymentReceipt } from "../services/receiptAnalysisService";

const paymentId = Number(process.argv[2]);

if (!Number.isInteger(paymentId) || paymentId <= 0) {
  console.error("Usage: tsx src/scripts/analyzePaymentReceiptToDb.ts <payment-id>");
  process.exit(1);
}

async function main() {
  const result = await analyzeAndSavePaymentReceipt(paymentId);

  console.log(`Payment id: ${result.paymentId}`);
  console.log(`Receipt file path: ${result.receiptFilePath}`);
  console.log(`Extracted text length: ${result.extractedTextLength}`);
  console.log("Parsed AI result:");
  console.log(result.parsedAiResult);
  console.log("DB updated");
}

main().catch((error) => {
  console.error("Payment receipt analysis failed:");
  console.error(error);
  process.exit(1);
});
