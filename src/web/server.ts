import express from "express";
import { db } from "../database/db";
import { completeLesson } from "../services/lessonCompletionService";

const app = express();
const port = Number(process.env.ADMIN_PORT ?? 3000);

type Student = {
  id: number;
  name_ru: string;
  name_ar: string;
  telegram_username: string | null;
  telegram_id: string | null;
  calendar_keyword: string;
  is_active: number;
  created_at: string;
};

type LessonRow = {
  id: number;
  title: string;
  name_ru: string | null;
  start_time: string;
  status: string;
  student_response: string | null;
  payment_status: string | null;
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; color: #1f2937; }
      nav { margin-bottom: 24px; }
      nav a { margin-right: 16px; }
      table { border-collapse: collapse; width: 100%; margin-top: 20px; }
      th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; }
      th { background: #f3f4f6; }
      form { margin-top: 20px; }
      label { display: block; margin-top: 12px; }
      input { padding: 8px; width: min(420px, 100%); }
      button { padding: 8px 12px; margin-top: 12px; }
      .error { color: #b91c1c; }
    </style>
  </head>
  <body>
    <nav>
      <a href="/students">Students</a>
      <a href="/lessons">Lessons</a>
    </nav>
    ${body}
  </body>
</html>`;
}

function normalizeTelegramUsername(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

app.use(express.urlencoded({ extended: false }));

app.get("/", (_request, response) => {
  response.redirect("/students");
});

app.get("/students", (_request, response) => {
  const students = db
    .prepare(
      `
        SELECT
          id,
          name_ru,
          name_ar,
          telegram_username,
          telegram_id,
          calendar_keyword,
          is_active,
          created_at
        FROM students
        ORDER BY id
      `
    )
    .all() as Student[];

  const rows = students
    .map(
      (student) => `<tr>
        <td>${student.id}</td>
        <td>${escapeHtml(student.name_ru)}</td>
        <td>${escapeHtml(student.name_ar)}</td>
        <td>${escapeHtml(student.telegram_username)}</td>
        <td>${escapeHtml(student.telegram_id)}</td>
        <td>${escapeHtml(student.calendar_keyword)}</td>
        <td>${student.is_active}</td>
        <td>${escapeHtml(student.created_at)}</td>
      </tr>`
    )
    .join("");

  response.send(
    layout(
      "Students",
      `<h1>Students</h1>
      <form method="post" action="/students">
        <h2>Add student</h2>
        <label>Russian name <input name="name_ru"></label>
        <label>Arabic name <input name="name_ar"></label>
        <label>Telegram username <input name="telegram_username"></label>
        <label>Calendar keyword <input name="calendar_keyword" required></label>
        <button type="submit">Create student</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name RU</th>
            <th>Name AR</th>
            <th>Telegram username</th>
            <th>Telegram ID</th>
            <th>Calendar keyword</th>
            <th>Active</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    )
  );
});

app.post("/students", (request, response) => {
  const nameRu = String(request.body.name_ru ?? "").trim();
  const nameAr = String(request.body.name_ar ?? "").trim();
  const calendarKeyword = String(request.body.calendar_keyword ?? "").trim();
  const telegramUsername = normalizeTelegramUsername(
    String(request.body.telegram_username ?? "")
  );

  if ((!nameRu && !nameAr) || !calendarKeyword) {
    response.status(400).send(
      layout(
        "Invalid student",
        `<p class="error">Provide at least one name and a calendar keyword.</p>`
      )
    );
    return;
  }

  db.prepare(
    `
      INSERT INTO students (
        name_ru,
        name_ar,
        telegram_username,
        telegram_id,
        calendar_keyword,
        is_active,
        created_at
      )
      VALUES (?, ?, ?, '', ?, 1, datetime('now'))
    `
  ).run(nameRu, nameAr, telegramUsername, calendarKeyword);

  response.redirect("/students");
});

app.get("/lessons", (_request, response) => {
  const lessons = db
    .prepare(
      `
        SELECT
          lessons.id,
          lessons.title,
          students.name_ru,
          lessons.start_time,
          lessons.status,
          lessons.student_response,
          payments.status AS payment_status
        FROM lessons
        LEFT JOIN students ON students.id = lessons.student_id
        LEFT JOIN payments ON payments.lesson_id = lessons.id
        ORDER BY lessons.start_time DESC
      `
    )
    .all() as LessonRow[];

  const rows = lessons
    .map((lesson) => {
      const completionButton =
        lesson.status === "scheduled" || lesson.status === "confirmed"
          ? `<form method="post" action="/lessons/${lesson.id}/complete">
              <button type="submit">تم الدرس</button>
            </form>`
          : "";

      return `<tr>
        <td>${lesson.id}</td>
        <td>${escapeHtml(lesson.title)}</td>
        <td>${escapeHtml(lesson.name_ru)}</td>
        <td>${escapeHtml(lesson.start_time)}</td>
        <td>${escapeHtml(lesson.status)}</td>
        <td>${escapeHtml(lesson.student_response)}</td>
        <td>${escapeHtml(lesson.payment_status)}</td>
        <td>${completionButton}</td>
      </tr>`;
    })
    .join("");

  response.send(
    layout(
      "Lessons",
      `<h1>Lessons</h1>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Title</th>
            <th>Student</th>
            <th>Start time</th>
            <th>Status</th>
            <th>Student response</th>
            <th>Payment status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    )
  );
});

app.post("/lessons/:id/complete", async (request, response) => {
  const lessonId = Number(request.params.id);

  if (!Number.isInteger(lessonId) || lessonId <= 0) {
    response.status(400).send(layout("Invalid lesson", "<p>Invalid lesson ID.</p>"));
    return;
  }

  await completeLesson(lessonId);
  response.redirect("/lessons");
});

app.listen(port, () => {
  console.log(`Admin server listening on http://localhost:${port}`);
});
