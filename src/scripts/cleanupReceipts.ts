import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ReceiptCleanupConfig = {
  enabled: boolean;
  receiptsDir: string;
  receiptRetentionDays: number;
  tmpRetentionDays: number;
};

export type ReceiptCleanupSummary = {
  scannedFiles: number;
  deletedReceiptFiles: number;
  deletedTmpFiles: number;
  skippedFiles: number;
  freedBytes: number;
};

const millisecondsPerDay = 24 * 60 * 60 * 1000;

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  return value.trim().toLowerCase() === "true";
}

function parsePositiveNumber(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function isInsideDirectory(parentDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentDir, candidatePath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function isReceiptPdf(filename: string): boolean {
  return filename.endsWith("-receipt.pdf");
}

function createEmptySummary(): ReceiptCleanupSummary {
  return {
    scannedFiles: 0,
    deletedReceiptFiles: 0,
    deletedTmpFiles: 0,
    skippedFiles: 0,
    freedBytes: 0,
  };
}

export function getReceiptCleanupConfigFromEnv(): ReceiptCleanupConfig {
  return {
    enabled: parseBoolean(process.env.RECEIPT_CLEANUP_ENABLED, false),
    receiptsDir: process.env.RECEIPT_CLEANUP_DIR || "data/receipts",
    receiptRetentionDays: parsePositiveNumber(
      process.env.RECEIPT_RETENTION_DAYS,
      7
    ),
    tmpRetentionDays: parsePositiveNumber(
      process.env.RECEIPT_TMP_RETENTION_DAYS,
      1
    ),
  };
}

async function deleteFileIfSafe(input: {
  filePath: string;
  baseDir: string;
  cutoffMs: number;
  nowMs: number;
}): Promise<{ deleted: boolean; freedBytes: number }> {
  const resolvedFilePath = path.resolve(input.filePath);

  if (!isInsideDirectory(input.baseDir, resolvedFilePath)) {
    return { deleted: false, freedBytes: 0 };
  }

  const stat = await fs.lstat(resolvedFilePath);

  if (!stat.isFile()) {
    return { deleted: false, freedBytes: 0 };
  }

  if (stat.mtimeMs > input.nowMs - input.cutoffMs) {
    return { deleted: false, freedBytes: 0 };
  }

  await fs.unlink(resolvedFilePath);

  return {
    deleted: true,
    freedBytes: stat.size,
  };
}

export async function cleanupReceipts(
  config: ReceiptCleanupConfig = getReceiptCleanupConfigFromEnv(),
  nowMs = Date.now()
): Promise<ReceiptCleanupSummary> {
  const summary = createEmptySummary();

  if (!config.enabled) {
    console.log("receipt cleanup disabled");
    return summary;
  }

  const receiptsDir = path.resolve(config.receiptsDir);
  const tmpDir = path.resolve(receiptsDir, "tmp");

  try {
    const receiptEntries = await fs.readdir(receiptsDir, {
      withFileTypes: true,
    });

    for (const entry of receiptEntries) {
      const entryPath = path.resolve(receiptsDir, entry.name);

      if (!isInsideDirectory(receiptsDir, entryPath)) {
        summary.skippedFiles += 1;
        continue;
      }

      if (entry.isDirectory()) {
        continue;
      }

      summary.scannedFiles += 1;

      if (!entry.isFile() || !isReceiptPdf(entry.name)) {
        summary.skippedFiles += 1;
        continue;
      }

      const result = await deleteFileIfSafe({
        filePath: entryPath,
        baseDir: receiptsDir,
        cutoffMs: config.receiptRetentionDays * millisecondsPerDay,
        nowMs,
      });

      if (result.deleted) {
        summary.deletedReceiptFiles += 1;
        summary.freedBytes += result.freedBytes;
      } else {
        summary.skippedFiles += 1;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  try {
    const tmpEntries = await fs.readdir(tmpDir, { withFileTypes: true });

    for (const entry of tmpEntries) {
      const entryPath = path.resolve(tmpDir, entry.name);

      if (!isInsideDirectory(tmpDir, entryPath)) {
        summary.skippedFiles += 1;
        continue;
      }

      if (entry.isDirectory()) {
        continue;
      }

      summary.scannedFiles += 1;

      if (!entry.isFile()) {
        summary.skippedFiles += 1;
        continue;
      }

      const result = await deleteFileIfSafe({
        filePath: entryPath,
        baseDir: tmpDir,
        cutoffMs: config.tmpRetentionDays * millisecondsPerDay,
        nowMs,
      });

      if (result.deleted) {
        summary.deletedTmpFiles += 1;
        summary.freedBytes += result.freedBytes;
      } else {
        summary.skippedFiles += 1;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main(): Promise<void> {
  await cleanupReceipts();
}

const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (currentFilePath === executedFilePath) {
  void main().catch((error) => {
    console.error("Receipt cleanup failed:");
    console.error(error instanceof Error ? error.message : "unknown error");
    process.exit(1);
  });
}
