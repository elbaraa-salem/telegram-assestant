import Database from "better-sqlite3";
import fs from "node:fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "app.db");

fs.mkdirSync(dataDir, { recursive: true });

// If the main database was intentionally removed, stale sidecars from the old
// database must not be reused for the fresh file.
if (!fs.existsSync(dbPath)) {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecarPath = `${dbPath}${suffix}`;

    if (fs.existsSync(sidecarPath)) {
      fs.rmSync(sidecarPath);
    }
  }
}

export const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    name_ru TEXT NOT NULL,
    name_ar TEXT NOT NULL,

    telegram_username TEXT,
    telegram_id TEXT,

    calendar_keyword TEXT NOT NULL UNIQUE,

    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    google_event_id TEXT NOT NULL UNIQUE,
    student_id INTEGER,

    title TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'scheduled',
    google_status TEXT,
    student_response TEXT,
    student_response_at TEXT,

    reminder_sent INTEGER NOT NULL DEFAULT 0,
    reminder_sent_at TEXT,
    reminder_message_id TEXT,
    reminder_error TEXT,
    payment_request_sent INTEGER NOT NULL DEFAULT 0,

    cancellation_source TEXT,
    awaiting_cancellation_reason INTEGER NOT NULL DEFAULT 0,
    cancellation_reason TEXT,
    cancellation_requested_at TEXT,
    cancellation_confirmed_at TEXT,
    cancellation_confirmed_by TEXT DEFAULT 'admin',
    ai_cancellation_confidence REAL,
    google_deleted_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL,

    FOREIGN KEY (student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    lesson_id INTEGER,
    student_id INTEGER NOT NULL,

    status TEXT NOT NULL DEFAULT 'unpaid',

    amount INTEGER,
    currency TEXT NOT NULL DEFAULT 'RUB',

    requested_at TEXT,
    receipt_received_at TEXT,
    paid_at TEXT,

    telegram_message_id TEXT,
    telegram_file_id TEXT,

    receipt_file_path TEXT,
    receipt_text TEXT,

    ai_amount REAL,
    ai_currency TEXT,
    ai_payment_date TEXT,
    ai_confidence REAL,
    ai_raw_result TEXT,

    prepaid_package_id INTEGER,
    payment_method TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (lesson_id) REFERENCES lessons(id),
    FOREIGN KEY (student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS lesson_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    total_lessons INTEGER NOT NULL,
    used_lessons INTEGER NOT NULL DEFAULT 0,
    amount REAL,
    currency TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    paid_at TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS telegram_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    student_id INTEGER,
    telegram_chat_id TEXT NOT NULL,
    telegram_message_id TEXT NOT NULL,

    sender TEXT NOT NULL,
    text TEXT,

    sent_at TEXT NOT NULL,
    sender_id TEXT,
    message_date TEXT,
    has_media INTEGER NOT NULL DEFAULT 0,
    media_type TEXT,
    processed_at TEXT,
    processing_status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (telegram_chat_id, telegram_message_id),

    FOREIGN KEY (student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS lesson_cancellation_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    lesson_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,

    ai_decision TEXT NOT NULL,
    ai_confidence REAL NOT NULL,
    ai_reason TEXT,
    ai_raw_result TEXT,

    analyzed_from TEXT NOT NULL,
    analyzed_to TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (lesson_id) REFERENCES lessons(id),
    FOREIGN KEY (student_id) REFERENCES students(id)
  );
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_google_event_id
    ON lessons(google_event_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_messages_chat_message
    ON telegram_messages(telegram_chat_id, telegram_message_id);
`);

function addColumnIfMissing(sql: string): void {
  try {
    db.exec(sql);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("duplicate column name")
    ) {
      return;
    }

    throw error;
  }
}

function paymentColumnExists(columnName: string): boolean {
  const columns = db.prepare("PRAGMA table_info(payments)").all() as Array<{
    name: string;
  }>;

  return columns.some((column) => column.name === columnName);
}

function addPaymentColumnIfMissing(columnName: string, definition: string): void {
  if (paymentColumnExists(columnName)) {
    return;
  }

  db.exec(`ALTER TABLE payments ADD COLUMN ${definition}`);
}

function tableExists(tableName: string): boolean {
  const row = db
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = ?
      `
    )
    .get(tableName) as { name: string } | undefined;

  return Boolean(row);
}

function migratePaymentsTableIfNeeded(): void {
  const columns = db.prepare("PRAGMA table_info(payments)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const selectColumn = (columnName: string): string =>
    columnNames.has(columnName) ? columnName : "NULL";
  const lessonIdColumn = columns.find((column) => column.name === "lesson_id");
  const indexes = db.prepare("PRAGMA index_list(payments)").all() as Array<{
    name: string;
    unique: number;
  }>;
  const hasUniqueLessonIndex = indexes.some(
    (index) => index.unique === 1 && index.name === "idx_payments_lesson_id"
  );

  if (lessonIdColumn?.notnull !== 1 && !hasUniqueLessonIndex) {
    return;
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_payments_lesson_id;

    CREATE TABLE payments_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id INTEGER,
      student_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'unpaid',
      amount INTEGER,
      currency TEXT NOT NULL DEFAULT 'RUB',
      requested_at TEXT,
      receipt_received_at TEXT,
      paid_at TEXT,
      telegram_message_id TEXT,
      telegram_file_id TEXT,
      receipt_file_path TEXT,
      receipt_text TEXT,
      ai_amount REAL,
      ai_currency TEXT,
      ai_payment_date TEXT,
      ai_confidence REAL,
      ai_raw_result TEXT,
      receipt_fingerprint TEXT,
      receipt_document_number TEXT,
      receipt_operation_id TEXT,
      manage_spend_notified_at TEXT,
      manage_spend_message_id TEXT,
      manage_spend_notify_error TEXT,
      prepaid_package_id INTEGER,
      payment_method TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lesson_id) REFERENCES lessons(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    INSERT INTO payments_new (
      id,
      lesson_id,
      student_id,
      status,
      amount,
      currency,
      requested_at,
      receipt_received_at,
      paid_at,
      telegram_message_id,
      telegram_file_id,
      receipt_file_path,
      receipt_text,
      ai_amount,
      ai_currency,
      ai_payment_date,
      ai_confidence,
      ai_raw_result,
      receipt_fingerprint,
      receipt_document_number,
      receipt_operation_id,
      manage_spend_notified_at,
      manage_spend_message_id,
      manage_spend_notify_error,
      prepaid_package_id,
      payment_method,
      created_at,
      updated_at
    )
    SELECT
      id,
      lesson_id,
      student_id,
      status,
      amount,
      currency,
      requested_at,
      receipt_received_at,
      paid_at,
      telegram_message_id,
      telegram_file_id,
      receipt_file_path,
      ${selectColumn("receipt_text")},
      ${selectColumn("ai_amount")},
      ${selectColumn("ai_currency")},
      ${selectColumn("ai_payment_date")},
      ${selectColumn("ai_confidence")},
      ${selectColumn("ai_raw_result")},
      ${selectColumn("receipt_fingerprint")},
      ${selectColumn("receipt_document_number")},
      ${selectColumn("receipt_operation_id")},
      ${selectColumn("manage_spend_notified_at")},
      ${selectColumn("manage_spend_message_id")},
      ${selectColumn("manage_spend_notify_error")},
      ${selectColumn("prepaid_package_id")},
      ${selectColumn("payment_method")},
      created_at,
      updated_at
    FROM payments;

    DROP TABLE payments;
    ALTER TABLE payments_new RENAME TO payments;
  `);
}

function migrateLessonChargesTableIfNeeded(): void {
  if (!tableExists("lesson_charges")) {
    return;
  }

  const columns = db.prepare("PRAGMA table_info(lesson_charges)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const lessonIdColumn = columns.find((column) => column.name === "lesson_id");
  const hasChargeType = columns.some((column) => column.name === "charge_type");
  const hasNote = columns.some((column) => column.name === "note");

  if (lessonIdColumn?.notnull !== 1 && hasChargeType && hasNote) {
    return;
  }

  const chargeTypeSelect = hasChargeType
    ? "COALESCE(charge_type, 'lesson')"
    : "'lesson'";
  const noteSelect = hasNote ? "note" : "NULL";

  db.exec(`
    CREATE TABLE lesson_charges_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id INTEGER UNIQUE,
      student_id INTEGER NOT NULL,
      charge_type TEXT NOT NULL DEFAULT 'lesson',
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'RUB',
      status TEXT NOT NULL DEFAULT 'unpaid',
      paid_amount INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (lesson_id) REFERENCES lessons(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    INSERT INTO lesson_charges_new (
      id,
      lesson_id,
      student_id,
      charge_type,
      amount,
      currency,
      status,
      paid_amount,
      note,
      created_at,
      updated_at
    )
    SELECT
      id,
      lesson_id,
      student_id,
      ${chargeTypeSelect},
      amount,
      currency,
      status,
      paid_amount,
      ${noteSelect},
      created_at,
      updated_at
    FROM lesson_charges;

    DROP TABLE lesson_charges;
    ALTER TABLE lesson_charges_new RENAME TO lesson_charges;
  `);
}

function normalizeLessonTimestamp(startTime: string): string {
  return startTime.replace(/([+-]\d{2})$/, "$1:00");
}

function parseLessonTimestamp(startTime: string): number {
  return Date.parse(normalizeLessonTimestamp(startTime));
}

function backfillReminderSentAtForScheduledFutureLessons(): void {
  const lessons = db
    .prepare(
      `
        SELECT id, start_time, updated_at
        FROM lessons
        WHERE status = 'scheduled'
          AND reminder_sent = 1
          AND reminder_sent_at IS NULL
          AND google_deleted_at IS NULL
      `
    )
    .all() as Array<{
    id: number;
    start_time: string;
    updated_at: string | null;
  }>;

  const now = Date.now();
  const updateReminderSentAt = db.prepare(
    `
      UPDATE lessons
      SET reminder_sent_at = COALESCE(?, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
        AND status = 'scheduled'
        AND reminder_sent = 1
        AND reminder_sent_at IS NULL
        AND google_deleted_at IS NULL
    `
  );

  for (const lesson of lessons) {
    const startTimeMs = parseLessonTimestamp(lesson.start_time);

    if (!Number.isNaN(startTimeMs) && startTimeMs > now) {
      updateReminderSentAt.run(lesson.updated_at, lesson.id);
    }
  }
}

export function repairGoogleDeletedScheduledLessons(): void {
  db.prepare(
    `
      UPDATE lessons
      SET status = 'cancelled',
          cancellation_source = COALESCE(cancellation_source, 'teacher'),
          updated_at = CURRENT_TIMESTAMP
      WHERE google_deleted_at IS NOT NULL
        AND status = 'scheduled'
    `
  ).run();
}

addColumnIfMissing("ALTER TABLE lessons ADD COLUMN student_response TEXT");
addColumnIfMissing("ALTER TABLE lessons ADD COLUMN student_response_at TEXT");
addColumnIfMissing("ALTER TABLE lessons ADD COLUMN reminder_sent_at TEXT");
addColumnIfMissing("ALTER TABLE lessons ADD COLUMN reminder_message_id TEXT");
addColumnIfMissing("ALTER TABLE lessons ADD COLUMN reminder_error TEXT");
addColumnIfMissing(
  "ALTER TABLE lessons ADD COLUMN awaiting_cancellation_reason INTEGER NOT NULL DEFAULT 0"
);
addColumnIfMissing("ALTER TABLE lessons ADD COLUMN cancellation_source TEXT");
addColumnIfMissing("ALTER TABLE lessons ADD COLUMN cancellation_reason TEXT");
addColumnIfMissing("ALTER TABLE lessons ADD COLUMN cancellation_requested_at TEXT");
addColumnIfMissing("ALTER TABLE lessons ADD COLUMN cancellation_confirmed_at TEXT");
addColumnIfMissing(
  "ALTER TABLE lessons ADD COLUMN cancellation_confirmed_by TEXT DEFAULT 'admin'"
);
addColumnIfMissing("ALTER TABLE lessons ADD COLUMN google_deleted_at TEXT");
repairGoogleDeletedScheduledLessons();
backfillReminderSentAtForScheduledFutureLessons();
addColumnIfMissing(
  "ALTER TABLE students ADD COLUMN lesson_price_amount INTEGER NOT NULL DEFAULT 0"
);
addColumnIfMissing(
  "ALTER TABLE students ADD COLUMN lesson_price_currency TEXT NOT NULL DEFAULT 'RUB'"
);
addColumnIfMissing("ALTER TABLE students ADD COLUMN welcome_message_sent_at TEXT");
addColumnIfMissing("ALTER TABLE students ADD COLUMN welcome_message_id TEXT");
addColumnIfMissing("ALTER TABLE students ADD COLUMN welcome_message_error TEXT");
addColumnIfMissing("ALTER TABLE payments ADD COLUMN prepaid_package_id INTEGER");
addColumnIfMissing("ALTER TABLE payments ADD COLUMN payment_method TEXT");
addColumnIfMissing("ALTER TABLE telegram_messages ADD COLUMN sender_id TEXT");
addColumnIfMissing("ALTER TABLE telegram_messages ADD COLUMN message_date TEXT");
addColumnIfMissing(
  "ALTER TABLE telegram_messages ADD COLUMN has_media INTEGER NOT NULL DEFAULT 0"
);
addColumnIfMissing("ALTER TABLE telegram_messages ADD COLUMN media_type TEXT");
addColumnIfMissing("ALTER TABLE telegram_messages ADD COLUMN processed_at TEXT");
addColumnIfMissing(
  "ALTER TABLE telegram_messages ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'pending'"
);
addColumnIfMissing("ALTER TABLE telegram_messages ADD COLUMN error TEXT");
addPaymentColumnIfMissing("receipt_text", "receipt_text TEXT");
addPaymentColumnIfMissing("ai_amount", "ai_amount REAL");
addPaymentColumnIfMissing("ai_currency", "ai_currency TEXT");
addPaymentColumnIfMissing("ai_payment_date", "ai_payment_date TEXT");
addPaymentColumnIfMissing("ai_confidence", "ai_confidence REAL");
addPaymentColumnIfMissing("ai_raw_result", "ai_raw_result TEXT");
addPaymentColumnIfMissing("receipt_fingerprint", "receipt_fingerprint TEXT");
addPaymentColumnIfMissing("receipt_document_number", "receipt_document_number TEXT");
addPaymentColumnIfMissing("receipt_operation_id", "receipt_operation_id TEXT");
addPaymentColumnIfMissing("manage_spend_notified_at", "manage_spend_notified_at TEXT");
addPaymentColumnIfMissing("manage_spend_message_id", "manage_spend_message_id TEXT");
addPaymentColumnIfMissing("manage_spend_notify_error", "manage_spend_notify_error TEXT");

migratePaymentsTableIfNeeded();
migrateLessonChargesTableIfNeeded();

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_payments_lesson_id_lookup
    ON payments(lesson_id);

  UPDATE payments
  SET telegram_message_id = NULL
  WHERE telegram_message_id IS NOT NULL
    AND id NOT IN (
      SELECT MIN(id)
      FROM payments
      WHERE telegram_message_id IS NOT NULL
      GROUP BY telegram_message_id
    );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_telegram_message_id_unique
    ON payments(telegram_message_id)
    WHERE telegram_message_id IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_receipt_fingerprint_unique
    ON payments(receipt_fingerprint)
    WHERE receipt_fingerprint IS NOT NULL;

  CREATE TABLE IF NOT EXISTS lesson_charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id INTEGER UNIQUE,
    student_id INTEGER NOT NULL,
    charge_type TEXT NOT NULL DEFAULT 'lesson',
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'RUB',
    status TEXT NOT NULL DEFAULT 'unpaid',
    paid_amount INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lesson_id) REFERENCES lessons(id),
    FOREIGN KEY (student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS payment_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL,
    lesson_charge_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (payment_id) REFERENCES payments(id),
    FOREIGN KEY (lesson_charge_id) REFERENCES lesson_charges(id)
  );

  CREATE INDEX IF NOT EXISTS idx_lesson_charges_student_status
    ON lesson_charges(student_id, status, created_at);

  CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment
    ON payment_allocations(payment_id);

  CREATE INDEX IF NOT EXISTS idx_payment_allocations_charge
    ON payment_allocations(lesson_charge_id);
`);
