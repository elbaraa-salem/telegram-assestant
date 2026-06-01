import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "telegram-assistant-receipt-cleanup-test-")
);
const receiptsDir = path.join(tempDir, "data", "receipts");
const tmpDir = path.join(receiptsDir, "tmp");
const nowMs = Date.parse("2026-06-01T10:00:00.000Z");

process.chdir(tempDir);

const { cleanupReceipts } = await import("./cleanupReceipts");

async function writeFileWithAge(
  filePath: string,
  content: string,
  ageDays: number
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  const timestamp = new Date(nowMs - ageDays * 24 * 60 * 60 * 1000);
  await fs.utimes(filePath, timestamp, timestamp);
}

await writeFileWithAge(
  path.join(receiptsDir, "student-1-message-1-receipt.pdf"),
  "old receipt",
  8
);
await writeFileWithAge(
  path.join(receiptsDir, "student-1-message-2-receipt.pdf"),
  "recent receipt",
  2
);
await writeFileWithAge(path.join(receiptsDir, "lesson-book.pdf"), "book", 30);
await writeFileWithAge(path.join(receiptsDir, "notes.txt"), "notes", 30);
await writeFileWithAge(path.join(tmpDir, "download.tmp"), "tmp old", 2);
await writeFileWithAge(path.join(tmpDir, "download-new.tmp"), "tmp new", 0.5);
await fs.mkdir(path.join(tmpDir, "nested"), { recursive: true });

const disabledSummary = await cleanupReceipts(
  {
    enabled: false,
    receiptsDir,
    receiptRetentionDays: 7,
    tmpRetentionDays: 1,
  },
  nowMs
);

assert.deepEqual(disabledSummary, {
  scannedFiles: 0,
  deletedReceiptFiles: 0,
  deletedTmpFiles: 0,
  skippedFiles: 0,
  freedBytes: 0,
});
assert.equal(
  await fs
    .access(path.join(receiptsDir, "student-1-message-1-receipt.pdf"))
    .then(() => true, () => false),
  true
);

const summary = await cleanupReceipts(
  {
    enabled: true,
    receiptsDir,
    receiptRetentionDays: 7,
    tmpRetentionDays: 1,
  },
  nowMs
);

assert.equal(summary.deletedReceiptFiles, 1);
assert.equal(summary.deletedTmpFiles, 1);
assert.equal(summary.scannedFiles, 6);
assert.equal(summary.skippedFiles, 4);
assert.ok(summary.freedBytes > 0);

assert.equal(
  await fs
    .access(path.join(receiptsDir, "student-1-message-1-receipt.pdf"))
    .then(() => true, () => false),
  false
);
assert.equal(
  await fs
    .access(path.join(receiptsDir, "student-1-message-2-receipt.pdf"))
    .then(() => true, () => false),
  true
);
assert.equal(
  await fs.access(path.join(tmpDir, "download.tmp")).then(() => true, () => false),
  false
);
assert.equal(await fs.access(tmpDir).then(() => true, () => false), true);
assert.equal(
  await fs.access(path.join(receiptsDir, "lesson-book.pdf")).then(
    () => true,
    () => false
  ),
  true
);
assert.equal(
  await fs.access(path.join(tmpDir, "download-new.tmp")).then(
    () => true,
    () => false
  ),
  true
);

console.log("receipt cleanup tests passed");
