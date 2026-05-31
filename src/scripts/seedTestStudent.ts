import "dotenv/config";
import { db } from "../database/db";

type Student = {
  id: number;
  name_ru: string;
  name_ar: string;
  telegram_username: string | null;
  telegram_id: string | null;
  calendar_keyword: string;
  lesson_price_amount: number;
  lesson_price_currency: string;
  is_active: number;
  created_at: string;
};

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function normalizeTelegramUsername(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

const nameRu = requireEnv("TEST_STUDENT_NAME_RU");
const nameAr = requireEnv("TEST_STUDENT_NAME_AR");
const telegramUsername = normalizeTelegramUsername(
  requireEnv("TEST_STUDENT_TELEGRAM_USERNAME")
);
const calendarKeyword = requireEnv("TEST_STUDENT_CALENDAR_KEYWORD");
const lessonPriceAmount = Number(process.env.TEST_STUDENT_LESSON_PRICE_AMOUNT ?? 1000);
const lessonPriceCurrency =
  process.env.TEST_STUDENT_LESSON_PRICE_CURRENCY?.trim() || "RUB";

if (!Number.isFinite(lessonPriceAmount) || lessonPriceAmount < 0) {
  throw new Error("TEST_STUDENT_LESSON_PRICE_AMOUNT must be a non-negative number");
}

const matchingStudents = db
  .prepare(
    `
      SELECT *
      FROM students
      WHERE telegram_username = ?
         OR calendar_keyword = ?
      ORDER BY id
    `
  )
  .all(telegramUsername, calendarKeyword) as Student[];

if (matchingStudents.length > 1) {
  throw new Error(
    "Multiple students match TEST_STUDENT_TELEGRAM_USERNAME or TEST_STUDENT_CALENDAR_KEYWORD"
  );
}

let studentId: number;

if (matchingStudents.length === 1) {
  studentId = matchingStudents[0].id;

  db.prepare(
    `
      UPDATE students
      SET name_ru = ?,
          name_ar = ?,
          telegram_username = ?,
          telegram_id = NULL,
          calendar_keyword = ?,
          lesson_price_amount = ?,
          lesson_price_currency = ?,
          is_active = 1
      WHERE id = ?
    `
  ).run(
    nameRu,
    nameAr,
    telegramUsername,
    calendarKeyword,
    Math.round(lessonPriceAmount),
    lessonPriceCurrency,
    studentId
  );
} else {
  const result = db
    .prepare(
      `
        INSERT INTO students (
          name_ru,
          name_ar,
          telegram_username,
          telegram_id,
          calendar_keyword,
          lesson_price_amount,
          lesson_price_currency,
          is_active
        )
        VALUES (?, ?, ?, NULL, ?, ?, ?, 1)
      `
    )
    .run(
      nameRu,
      nameAr,
      telegramUsername,
      calendarKeyword,
      Math.round(lessonPriceAmount),
      lessonPriceCurrency
    );

  studentId = Number(result.lastInsertRowid);
}

const student = db
  .prepare("SELECT * FROM students WHERE id = ?")
  .get(studentId) as Student;

console.log("Seeded test student", student);
