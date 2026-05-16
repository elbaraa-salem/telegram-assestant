import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../database/db";
import {
  completeLesson,
  confirmLessonPayment,
} from "../services/lessonCompletionService";

const app = express();
const port = Number(process.env.ADMIN_PORT ?? 3000);
const currentDir = path.dirname(fileURLToPath(import.meta.url));

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
  cancellation_reason: string | null;
  cancellation_requested_at: string | null;
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

function normalizeTelegramUsername(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function buildAiReceipt(lesson: LessonRow) {
  const aiReceipt = {
    hasReceipt: Boolean(lesson.receipt_file_path),
    hasAiResult: Boolean(lesson.ai_raw_result),
    paymentConfirmed: null as boolean | null,
    amount: lesson.ai_amount,
    currency: lesson.ai_currency,
    paymentDate: lesson.ai_payment_date,
    confidence: lesson.ai_confidence,
    reason: null as string | null,
    rawResult: lesson.ai_raw_result,
    parseFailed: false,
  };

  if (!lesson.ai_raw_result) {
    return aiReceipt;
  }

  try {
    const parsed = JSON.parse(lesson.ai_raw_result) as StoredReceiptAiResult;
    aiReceipt.paymentConfirmed = parsed.payment_confirmed ?? null;
    aiReceipt.reason = parsed.reason ?? null;
  } catch {
    aiReceipt.parseFailed = true;
  }

  return aiReceipt;
}

app.use(express.urlencoded({ extended: false }));
app.set("view engine", "ejs");
app.set("views", path.join(currentDir, "views"));
app.use("/styles", express.static(path.join(currentDir, "public", "styles")));

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

  response.render("layout", {
    title: "Students",
    page: "students",
    students,
  });
});

app.post("/students", (request, response) => {
  const nameRu = String(request.body.name_ru ?? "").trim();
  const nameAr = String(request.body.name_ar ?? "").trim();
  const calendarKeyword = String(request.body.calendar_keyword ?? "").trim();
  const telegramUsername = normalizeTelegramUsername(
    String(request.body.telegram_username ?? "")
  );
  const telegramId = String(request.body.telegram_id ?? "").trim() || null;

  if ((!nameRu && !nameAr) || !calendarKeyword) {
    response.status(400).render("layout", {
      title: "Invalid student",
      page: "error",
      message: "Provide at least one name and a calendar keyword.",
    });
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
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
    `
  ).run(nameRu, nameAr, telegramUsername, telegramId, calendarKeyword);

  response.redirect("/students");
});

function createLessonPackage(
  studentId: number,
  totalLessons: number,
  amount: number | null,
  currency: string,
  note: string | null
): void {
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
}

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
    response.status(400).render("layout", {
      title: "Invalid package",
      page: "error",
      message: "Invalid package.",
    });
    return;
  }

  createLessonPackage(studentId, totalLessons, amount, currency, note);

  response.redirect("/students");
});

app.post("/packages", (request, response) => {
  const studentQuery = String(request.body.student_query ?? "").trim();
  const totalLessons = Number(request.body.total_lessons);
  const amountRaw = String(request.body.amount ?? "").trim();
  const amount = amountRaw ? Number(amountRaw) : null;
  const currency = String(request.body.currency ?? "RUB").trim() || "RUB";
  const note = String(request.body.note ?? "").trim() || null;

  if (
    !studentQuery ||
    !Number.isInteger(totalLessons) ||
    totalLessons <= 0 ||
    (amount !== null && !Number.isFinite(amount))
  ) {
    response.status(400).render("layout", {
      title: "Invalid package",
      page: "error",
      message: "Provide a student and a valid lesson count.",
    });
    return;
  }

  const numericStudentId = /^\d+$/.test(studentQuery)
    ? Number(studentQuery)
    : null;
  const matchingStudents = db
    .prepare(
      `
        SELECT id
        FROM students
        WHERE (? IS NOT NULL AND id = ?)
           OR name_ru = ?
           OR name_ar = ?
           OR calendar_keyword = ?
           OR telegram_username = ?
      `
    )
    .all(
      numericStudentId,
      numericStudentId,
      studentQuery,
      studentQuery,
      studentQuery,
      normalizeTelegramUsername(studentQuery)
    ) as Array<{ id: number }>;

  if (matchingStudents.length === 0) {
    response.status(404).render("layout", {
      title: "Student not found",
      page: "error",
      message: "No student matched that value.",
    });
    return;
  }

  if (matchingStudents.length > 1) {
    response.status(400).render("layout", {
      title: "Student match is ambiguous",
      page: "error",
      message: "Multiple students matched. Use a more specific value.",
    });
    return;
  }

  createLessonPackage(
    matchingStudents[0].id,
    totalLessons,
    amount,
    currency,
    note
  );

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
          lessons.cancellation_reason,
          lessons.cancellation_requested_at,
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

  const viewLessons = lessons.map((lesson) => ({
    ...lesson,
    packageProgress:
      lesson.payment_method === "package" &&
      lesson.package_used_lessons !== null &&
      lesson.package_total_lessons !== null
        ? `${lesson.package_used_lessons} / ${lesson.package_total_lessons}`
        : "",
    canComplete: lesson.status === "scheduled" || lesson.status === "confirmed",
    canConfirmPayment: ["unpaid", "requested", "receipt_received", "rejected"].includes(
      lesson.payment_status ?? ""
    ),
    aiReceipt: buildAiReceipt(lesson),
  }));

  response.render("layout", {
    title: "Lessons",
    page: "lessons",
    lessons: viewLessons,
  });
});

app.post("/lessons/:id/complete", async (request, response) => {
  const lessonId = Number(request.params.id);

  if (!Number.isInteger(lessonId) || lessonId <= 0) {
    response.status(400).render("layout", {
      title: "Invalid lesson",
      page: "error",
      message: "Invalid lesson ID.",
    });
    return;
  }

  await completeLesson(lessonId);
  response.redirect("/lessons");
});

app.post("/lessons/:id/confirm-payment", async (request, response) => {
  const lessonId = Number(request.params.id);

  if (!Number.isInteger(lessonId) || lessonId <= 0) {
    response.status(400).render("layout", {
      title: "Invalid lesson",
      page: "error",
      message: "Invalid lesson ID.",
    });
    return;
  }

  await confirmLessonPayment(lessonId);
  response.redirect("/lessons");
});

app.listen(port, () => {
  console.log(`Admin server listening on http://localhost:${port}`);
});
