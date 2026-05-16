import express from "express";
import { db } from "../database/db";
import {
  completeLesson,
  confirmLessonPayment,
} from "../services/lessonCompletionService";

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
  package_id: number | null;
  package_used_lessons: number | null;
  package_total_lessons: number | null;
};

type LessonRow = {
  id: number;
  title: string;
  name_ru: string | null;
  start_time: string;
  status: string;
  student_response: string | null;
  payment_status: string | null;
  payment_method: string | null;
  package_used_lessons: number | null;
  package_total_lessons: number | null;
  receipt_file_path: string | null;
  receipt_text: string | null;
  ai_amount: number | null;
  ai_currency: string | null;
  ai_payment_date: string | null;
  ai_confidence: number | null;
  ai_raw_result: string | null;
};

type StoredReceiptAiResult = {
  payment_confirmed?: boolean;
  reason?: string;
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

function renderAiReceiptAnalysis(lesson: LessonRow): string {
  if (!lesson.receipt_file_path) {
    return "No receipt uploaded.";
  }

  if (!lesson.ai_raw_result) {
    return "Receipt received, AI analysis not available yet.";
  }

  try {
    const parsed = JSON.parse(lesson.ai_raw_result) as StoredReceiptAiResult;

    return `<div>
      <strong>AI receipt analysis</strong><br>
      Amount: ${escapeHtml(lesson.ai_amount)}<br>
      Currency: ${escapeHtml(lesson.ai_currency)}<br>
      Payment date: ${escapeHtml(lesson.ai_payment_date)}<br>
      Confidence: ${escapeHtml(lesson.ai_confidence)}<br>
      Payment confirmed: ${escapeHtml(parsed.payment_confirmed)}<br>
      Reason: ${escapeHtml(parsed.reason)}
    </div>`;
  } catch {
    return `<div>
      <strong>AI receipt analysis</strong><br>
      Raw result: ${escapeHtml(lesson.ai_raw_result)}
    </div>`;
  }
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
          students.id,
          students.name_ru,
          students.name_ar,
          students.telegram_username,
          students.telegram_id,
          students.calendar_keyword,
          students.is_active,
          students.created_at,
          lesson_packages.id AS package_id,
          lesson_packages.used_lessons AS package_used_lessons,
          lesson_packages.total_lessons AS package_total_lessons
        FROM students
        LEFT JOIN lesson_packages
          ON lesson_packages.id = (
            SELECT id
            FROM lesson_packages
            WHERE student_id = students.id
              AND status = 'active'
              AND used_lessons < total_lessons
            ORDER BY created_at ASC, id ASC
            LIMIT 1
          )
        ORDER BY students.id
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
        <td>${
          student.package_id
            ? `${student.package_used_lessons} / ${student.package_total_lessons}`
            : ""
        }</td>
        <td>${
          student.package_id &&
          student.package_total_lessons !== null &&
          student.package_used_lessons !== null
            ? student.package_total_lessons - student.package_used_lessons
            : ""
        }</td>
        <td>
          <form method="post" action="/students/${student.id}/packages">
            <input name="total_lessons" type="number" min="1" placeholder="Lessons" required>
            <input name="amount" type="number" step="0.01" placeholder="Amount">
            <input name="currency" value="RUB" placeholder="Currency">
            <input name="note" placeholder="Note">
            <button type="submit">Create package</button>
          </form>
        </td>
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
            <th>Active package</th>
            <th>Remaining lessons</th>
            <th>Create package</th>
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

app.post("/students/:id/packages", (request, response) => {
  const studentId = Number(request.params.id);
  const totalLessons = Number(request.body.total_lessons);
  const amountRaw = String(request.body.amount ?? "").trim();
  const amount = amountRaw ? Number(amountRaw) : null;
  const currency = String(request.body.currency ?? "RUB").trim() || "RUB";
  const note = String(request.body.note ?? "").trim() || null;

  if (
    !Number.isInteger(studentId) ||
    studentId <= 0 ||
    !Number.isInteger(totalLessons) ||
    totalLessons <= 0 ||
    (amount !== null && !Number.isFinite(amount))
  ) {
    response.status(400).send(layout("Invalid package", "<p>Invalid package.</p>"));
    return;
  }

  db.prepare(
    `
      INSERT INTO lesson_packages (
        student_id,
        total_lessons,
        used_lessons,
        amount,
        currency,
        status,
        paid_at,
        note,
        created_at,
        updated_at
      )
      VALUES (?, ?, 0, ?, ?, 'active', datetime('now'), ?, datetime('now'), datetime('now'))
    `
  ).run(studentId, totalLessons, amount, currency, note);

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
          payments.status AS payment_status,
          payments.payment_method,
          lesson_packages.used_lessons AS package_used_lessons,
          lesson_packages.total_lessons AS package_total_lessons,
          payments.receipt_file_path AS receipt_file_path,
          payments.receipt_text AS receipt_text,
          payments.ai_amount AS ai_amount,
          payments.ai_currency AS ai_currency,
          payments.ai_payment_date AS ai_payment_date,
          payments.ai_confidence AS ai_confidence,
          payments.ai_raw_result AS ai_raw_result
        FROM lessons
        LEFT JOIN students ON students.id = lessons.student_id
        LEFT JOIN payments ON payments.lesson_id = lessons.id
        LEFT JOIN lesson_packages ON lesson_packages.id = payments.prepaid_package_id
        ORDER BY lessons.start_time DESC
      `
    )
    .all() as LessonRow[];

  console.log("[admin /lessons] first lesson AI fields", {
    id: lessons[0]?.id,
    payment_status: lessons[0]?.payment_status,
    receipt_file_path: lessons[0]?.receipt_file_path,
    ai_amount: lessons[0]?.ai_amount,
    ai_currency: lessons[0]?.ai_currency,
    ai_payment_date: lessons[0]?.ai_payment_date,
    ai_confidence: lessons[0]?.ai_confidence,
    has_ai_raw_result: Boolean(lessons[0]?.ai_raw_result),
  });

  const rows = lessons
    .map((lesson) => {
      const completionButton =
        lesson.status === "scheduled" || lesson.status === "confirmed"
          ? `<form method="post" action="/lessons/${lesson.id}/complete">
              <button type="submit">تم الدرس</button>
            </form>`
          : "";
      const paymentAction =
        lesson.payment_status === "confirmed"
          ? "مدفوع"
          : ["unpaid", "requested", "receipt_received", "rejected"].includes(
                lesson.payment_status ?? ""
              )
            ? `<form method="post" action="/lessons/${lesson.id}/confirm-payment">
                <button type="submit">الدرس تم دفعه</button>
              </form>`
            : "";
      const packageProgress =
        lesson.payment_method === "package" &&
        lesson.package_used_lessons !== null &&
        lesson.package_total_lessons !== null
          ? `${lesson.package_used_lessons} / ${lesson.package_total_lessons}`
          : "";

      return `<tr>
        <td>${lesson.id}</td>
        <td>${escapeHtml(lesson.title)}</td>
        <td>${escapeHtml(lesson.name_ru)}</td>
        <td>${escapeHtml(lesson.start_time)}</td>
        <td>${escapeHtml(lesson.status)}</td>
        <td>${escapeHtml(lesson.student_response)}</td>
        <td>${escapeHtml(lesson.payment_status)}</td>
        <td>${escapeHtml(lesson.payment_method)}</td>
        <td>${escapeHtml(packageProgress)}</td>
        <td>${renderAiReceiptAnalysis(lesson)}</td>
        <td>${completionButton} ${paymentAction}</td>
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
            <th>Payment method</th>
            <th>Package progress</th>
            <th>AI receipt analysis</th>
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

app.post("/lessons/:id/confirm-payment", async (request, response) => {
  const lessonId = Number(request.params.id);

  if (!Number.isInteger(lessonId) || lessonId <= 0) {
    response.status(400).send(layout("Invalid lesson", "<p>Invalid lesson ID.</p>"));
    return;
  }

  await confirmLessonPayment(lessonId);
  response.redirect("/lessons");
});

app.listen(port, () => {
  console.log(`Admin server listening on http://localhost:${port}`);
});
