import { db } from "./database/db";

db.prepare(`
  INSERT OR IGNORE INTO students (
    name_ru,
    name_ar,
    telegram_username,
    telegram_id,
    calendar_keyword
  )
  VALUES (?, ?, ?, ?, ?)
`).run(
  "Бараа",
  "براء",
  "@baraa38",
  "79127921349",
  "براء"
);

const students = db.prepare(`
  SELECT * FROM students
`).all();

console.log(students);