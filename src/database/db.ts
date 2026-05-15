import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "data", "app.db");

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
    payment_request_sent INTEGER NOT NULL DEFAULT 0,

    cancellation_source TEXT,
    ai_cancellation_confidence REAL,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL,

    FOREIGN KEY (student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    lesson_id INTEGER NOT NULL UNIQUE,
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

    ai_amount INTEGER,
    ai_currency TEXT,
    ai_payment_date TEXT,
    ai_confidence REAL,
    ai_raw_result TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (lesson_id) REFERENCES lessons(id),
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

addColumnIfMissing("ALTER TABLE lessons ADD COLUMN student_response TEXT");
addColumnIfMissing("ALTER TABLE lessons ADD COLUMN student_response_at TEXT");
