import fs from "node:fs/promises";
import { PDFParse } from "pdf-parse";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: tsx src/scripts/extractReceiptText.ts <pdf-path>");
  process.exit(1);
}

async function main() {
  const data = await fs.readFile(filePath);
  const parser = new PDFParse({ data });

  try {
    const result = await parser.getText();
    const text = result.text.trim();

    console.log(`File path: ${filePath}`);
    console.log(`Extracted text length: ${text.length}`);

    if (!text) {
      console.log("No text extracted. This PDF may contain scanned images and may need OCR.");
      return;
    }

    console.log("Extracted text:");
    console.log(text);
  } finally {
    await parser.destroy();
  }
}

main().catch((error) => {
  console.error(`File path: ${filePath}`);
  console.error("Extraction failed:");
  console.error(error);
  process.exit(1);
});
