import fs from "node:fs";
import path from "node:path";
import { db } from "../database/db";

const tables = [
  "payments",
  "lessons",
  "telegram_messages",
  "lesson_cancellation_analysis",
  "lesson_packages",
  "students",
] as const;

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

function removeReceiptPdfs(): number {
  const receiptsDir = path.join(process.cwd(), "data", "receipts");

  if (!fs.existsSync(receiptsDir)) {
    return 0;
  }

  let removed = 0;
  for (const entry of fs.readdirSync(receiptsDir)) {
    if (entry.toLowerCase().endsWith(".pdf")) {
      fs.rmSync(path.join(receiptsDir, entry));
      removed += 1;
    }
  }

  return removed;
}

const before = Object.fromEntries(tables.map((table) => [table, countRows(table)]));

db.transaction(() => {
  for (const table of tables) {
    db.prepare(`DELETE FROM ${table}`).run();
  }

  for (const table of tables) {
    db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
  }
})();

const after = Object.fromEntries(tables.map((table) => [table, countRows(table)]));

console.log("Reset counts before:", before);
console.log("Reset counts after:", after);
console.log("Removed receipt PDFs:", removeReceiptPdfs());
