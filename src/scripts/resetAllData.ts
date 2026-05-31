import fs from "node:fs";
import path from "node:path";
import { db } from "../database/db";

const tables = [
  "payment_allocations",
  "lesson_charges",
  "payments",
  "lessons",
  "telegram_messages",
  "lesson_cancellation_analysis",
  "lesson_packages",
  "students",
  "app_settings",
] as const;

function createDatabaseBackup(): string | null {
  const dataDir = path.join(process.cwd(), "data");
  const dbPath = path.join(dataDir, "app.db");

  if (!fs.existsSync(dbPath)) {
    return null;
  }

  const backupDir = path.join(dataDir, "backups");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupBasePath = path.join(backupDir, `app-${timestamp}.db`);

  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(dbPath, backupBasePath);

  for (const suffix of ["-wal", "-shm"]) {
    const sidecarPath = `${dbPath}${suffix}`;

    if (fs.existsSync(sidecarPath)) {
      fs.copyFileSync(sidecarPath, `${backupBasePath}${suffix}`);
    }
  }

  return backupBasePath;
}

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
const backupPath = createDatabaseBackup();

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
console.log("Database backup:", backupPath ?? "no database file found");
console.log("Removed receipt PDFs:", removeReceiptPdfs());
