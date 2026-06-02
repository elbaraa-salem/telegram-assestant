import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../database/db";
import {
  addManualStudentPayment,
  completeLesson,
  confirmLessonPayment,
} from "../services/lessonCompletionService";
import {
  createManualCharge,
  getStudentBalanceSummary,
} from "../services/paymentBalanceService";
import {
  getCalendarRuntimeStatus,
  syncCalendarLessons,
  testCalendarConnection,
} from "../services/calendarSync";
import { sendStudentWelcomeMessage } from "../services/studentWelcomeService";

const app = express();
const port = Number(process.env.ADMIN_PORT ?? 3000);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const appMode = process.env.APP_MODE?.trim() || "development";
const calendarSyncOnWebStart =
  String(process.env.CALENDAR_SYNC_ON_WEB_START ?? "false").toLowerCase() ===
  "true";

type Student = {
  id: number;
  name_ru: string;
  name_ar: string;
  telegram_username: string | null;
  telegram_id: string | null;
  calendar_keyword: string;
  is_active: number;
  created_at: string;
  lesson_price_amount: number;
  lesson_price_currency: string;
  welcome_message_sent_at: string | null;
  welcome_message_id: string | null;
  welcome_message_error: string | null;
};

type LessonRow = {
  id: number;
  title: string;
  name_ru: string | null;
  start_time: string;
  status: string;
  google_deleted_at: string | null;
  student_response: string | null;
  cancellation_source: string | null;
  awaiting_cancellation_reason: number;
  cancellation_reason: string | null;
  cancellation_requested_at: string | null;
  payment_status: string | null;
  payment_method: string | null;
  charge_amount: number | null;
  charge_paid_amount: number | null;
  charge_status: string | null;
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

type LessonCancelRow = {
  id: number;
  title: string;
  name_ru: string | null;
  start_time: string;
  status: string;
  google_deleted_at: string | null;
  student_response: string | null;
  cancellation_source: string | null;
  awaiting_cancellation_reason: number;
  cancellation_reason: string | null;
  cancellation_requested_at: string | null;
};

const cancellableLessonStatuses = new Set([
  "scheduled",
  "confirmed",
  "ready",
  "cancellation_requested",
]);

const completedLessonStatuses = new Set(["completed"]);

function isCancellableLessonStatus(status: string): boolean {
  return cancellableLessonStatuses.has(status);
}

function isCancelledLessonStatus(status: string): boolean {
  return (
    status === "cancelled" ||
    status === "cancelled_by_student" ||
    status === "cancelled_by_teacher"
  );
}

function buildCancellationRequested(lesson: {
  awaiting_cancellation_reason: number;
  cancellation_reason: string | null;
  cancellation_requested_at: string | null;
}): boolean {
  return Boolean(
    lesson.awaiting_cancellation_reason ||
      lesson.cancellation_reason ||
      lesson.cancellation_requested_at
  );
}

function renderInvalidLesson(response: express.Response): void {
  response.status(400).render("layout", {
    title: "Invalid lesson",
    page: "error",
    message: "Invalid lesson ID.",
  });
}

function getCancelLesson(lessonId: number): LessonCancelRow | undefined {
  return db
    .prepare(
      `
        SELECT
          lessons.id,
          lessons.title,
          students.name_ru,
          lessons.start_time,
          lessons.status,
          lessons.google_deleted_at,
          lessons.student_response,
          lessons.cancellation_source,
          lessons.awaiting_cancellation_reason,
          lessons.cancellation_reason,
          lessons.cancellation_requested_at
        FROM lessons
        LEFT JOIN students ON students.id = lessons.student_id
        WHERE lessons.id = ?
      `
    )
    .get(lessonId) as LessonCancelRow | undefined;
}

function formatLessonStartTime(startTime: string): {
  date: string;
  time: string;
} {
  const lessonDate = new Date(startTime);

  if (Number.isNaN(lessonDate.getTime())) {
    return {
      date: startTime,
      time: "",
    };
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tomsk",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(lessonDate);

  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    date: `${partMap.day}.${partMap.month}.${partMap.year}`,
    time: `${partMap.hour}:${partMap.minute}`,
  };
}

function formatDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() + days);
  return nextDate;
}

function getAdminLessonsRange(query: Record<string, unknown>): {
  fromDate: string | null;
  toDate: string | null;
  label: string;
  mode: string;
} {
  const today = new Date();
  const pastDays = Number(process.env.LESSONS_ADMIN_PAST_DAYS ?? 7);
  const futureDays = Number(process.env.LESSONS_ADMIN_FUTURE_DAYS ?? 7);
  const safePastDays =
    Number.isFinite(pastDays) && pastDays >= 0 ? Math.round(pastDays) : 7;
  const safeFutureDays =
    Number.isFinite(futureDays) && futureDays >= 0 ? Math.round(futureDays) : 7;
  const mode = String(query.range ?? "current");

  if (mode === "all-future") {
    return {
      fromDate: formatDateInput(today),
      toDate: null,
      label: "all future lessons",
      mode,
    };
  }

  if (mode === "custom") {
    const fromDate = String(query.from ?? "").trim() || null;
    const toDate = String(query.to ?? "").trim() || null;

    return {
      fromDate,
      toDate,
      label: "custom range",
      mode,
    };
  }

  const offset = mode === "previous" ? -7 : mode === "next" ? 7 : 0;
  const anchorDate = addDays(today, offset);

  return {
    fromDate: formatDateInput(addDays(anchorDate, -safePastDays)),
    toDate: formatDateInput(addDays(anchorDate, safeFutureDays)),
    label: mode === "previous" ? "previous week" : mode === "next" ? "next week" : "current range",
    mode: mode === "previous" || mode === "next" ? mode : "current",
  };
}

function normalizeTelegramUsername(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function getStudentById(studentId: number): Student | undefined {
  return db
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
          students.lesson_price_amount,
          students.lesson_price_currency,
          students.welcome_message_sent_at,
          students.welcome_message_id,
          students.welcome_message_error
        FROM students
        WHERE students.id = ?
      `
    )
    .get(studentId) as Student | undefined;
}

function renderStudentNotFound(response: express.Response): void {
  response.status(404).render("layout", {
    title: "Student not found",
    page: "error",
    message: "Student not found.",
  });
}

function getStudentFormInput(body: Record<string, unknown>) {
  const lessonPriceAmount = Number(body.lesson_price_amount ?? 0);

  return {
    nameRu: String(body.name_ru ?? "").trim(),
    nameAr: String(body.name_ar ?? "").trim(),
    telegramUsername: normalizeTelegramUsername(
      String(body.telegram_username ?? "")
    ),
    telegramId: String(body.telegram_id ?? "").trim() || null,
    calendarKeyword: String(body.calendar_keyword ?? "").trim(),
    isActive: body.is_active === "1" || body.is_active === "on" ? 1 : 0,
    lessonPriceAmount,
    lessonPriceCurrency:
      String(body.lesson_price_currency ?? "RUB").trim() || "RUB",
  };
}

function isValidStudentInput(input: ReturnType<typeof getStudentFormInput>): boolean {
  return (
    Boolean(input.nameRu || input.nameAr) &&
    Boolean(input.calendarKeyword) &&
    Number.isFinite(input.lessonPriceAmount) &&
    input.lessonPriceAmount >= 0
  );
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
          students.lesson_price_amount,
          students.lesson_price_currency,
          students.welcome_message_sent_at,
          students.welcome_message_id,
          students.welcome_message_error
        FROM students
        ORDER BY students.id
      `
    )
    .all() as Student[];
  const viewStudents = students.map((student) => ({
    ...student,
    balance: getStudentBalanceSummary(student.id),
  }));

  response.render("layout", {
    title: "Students",
    page: "students",
    students: viewStudents,
    warning: String(_request.query.warning ?? ""),
  });
});

app.post("/students", async (request, response) => {
  const input = getStudentFormInput(request.body);

  if (!isValidStudentInput(input)) {
    response.status(400).render("layout", {
      title: "Invalid student",
      page: "error",
      message: "Provide at least one name and a calendar keyword.",
    });
    return;
  }

  const insertResult = db.prepare(
    `
      INSERT INTO students (
        name_ru,
        name_ar,
        telegram_username,
        telegram_id,
        calendar_keyword,
        lesson_price_amount,
        lesson_price_currency,
        is_active,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    `
  ).run(
    input.nameRu,
    input.nameAr,
    input.telegramUsername,
    input.telegramId,
    input.calendarKeyword,
    Math.round(input.lessonPriceAmount),
    input.lessonPriceCurrency
  );
  const studentId = Number(insertResult.lastInsertRowid);

  console.log("student created", {
    nameRu: input.nameRu,
    nameAr: input.nameAr,
    telegramUsername: input.telegramUsername || null,
    telegramId: input.telegramId,
    calendarKeyword: input.calendarKeyword,
    lessonPriceAmount: Math.round(input.lessonPriceAmount),
    lessonPriceCurrency: input.lessonPriceCurrency,
  });
  console.log("telegram id resolution result", {
    calendarKeyword: input.calendarKeyword,
    telegramId: input.telegramId,
    resolved: Boolean(input.telegramId),
    note: input.telegramId
      ? "telegram_id provided manually"
      : "telegram_id will be resolved from Telegram username or first message",
  });

  const welcomeResult = await sendStudentWelcomeMessage(studentId);

  if (welcomeResult.status === "failed") {
    response.redirect(
      `/students?warning=${encodeURIComponent(
        "Student was created, but Telegram ID could not be resolved, so welcome message was not sent."
      )}`
    );
    return;
  }

  response.redirect("/students");
});

app.post("/students/:id/send-welcome", async (request, response) => {
  const studentId = Number(request.params.id);

  if (!Number.isInteger(studentId) || studentId <= 0) {
    response.status(400).render("layout", {
      title: "Invalid student",
      page: "error",
      message: "Invalid student ID.",
    });
    return;
  }

  const student = getStudentById(studentId);

  if (!student) {
    renderStudentNotFound(response);
    return;
  }

  const welcomeResult = await sendStudentWelcomeMessage(studentId, {
    manual: true,
  });

  if (welcomeResult.status === "failed") {
    response.redirect(
      `/students?warning=${encodeURIComponent(
        "Welcome message was not sent: " + welcomeResult.error
      )}`
    );
    return;
  }

  response.redirect("/students");
});

app.post("/students/:id/sync-calendar", async (request, response) => {
  const studentId = Number(request.params.id);

  if (!Number.isInteger(studentId) || studentId <= 0) {
    response.status(400).render("layout", {
      title: "Invalid student",
      page: "error",
      message: "Invalid student ID.",
    });
    return;
  }

  const student = getStudentById(studentId);

  if (!student) {
    renderStudentNotFound(response);
    return;
  }

  try {
    await syncCalendarLessons({ studentId });
    response.redirect("/calendar");
  } catch (error) {
    console.error("student calendar sync failed", {
      studentId,
      error: error instanceof Error ? error.message : String(error),
    });
    response.status(500).render("layout", {
      title: "Calendar sync failed",
      page: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/students/:id/edit", (request, response) => {
  const studentId = Number(request.params.id);

  if (!Number.isInteger(studentId) || studentId <= 0) {
    response.status(400).render("layout", {
      title: "Invalid student",
      page: "error",
      message: "Invalid student ID.",
    });
    return;
  }

  const student = getStudentById(studentId);

  if (!student) {
    renderStudentNotFound(response);
    return;
  }

  response.render("layout", {
    title: "Edit student",
    page: "student-edit",
    student,
  });
});

app.post("/students/:id/edit", (request, response) => {
  const studentId = Number(request.params.id);

  if (!Number.isInteger(studentId) || studentId <= 0) {
    response.status(400).render("layout", {
      title: "Invalid student",
      page: "error",
      message: "Invalid student ID.",
    });
    return;
  }

  const student = getStudentById(studentId);

  if (!student) {
    renderStudentNotFound(response);
    return;
  }

  const input = getStudentFormInput(request.body);

  if (!isValidStudentInput(input)) {
    response.status(400).render("layout", {
      title: "Invalid student",
      page: "error",
      message: "Provide at least one name, a calendar keyword, and a valid price.",
    });
    return;
  }

  const updatedPriceAmount = Math.round(input.lessonPriceAmount);

  try {
    db.prepare(
      `
        UPDATE students
        SET name_ru = ?,
            name_ar = ?,
            telegram_username = ?,
            telegram_id = ?,
            calendar_keyword = ?,
            is_active = ?,
            lesson_price_amount = ?,
            lesson_price_currency = ?
        WHERE id = ?
      `
    ).run(
      input.nameRu,
      input.nameAr,
      input.telegramUsername,
      input.telegramId,
      input.calendarKeyword,
      input.isActive,
      updatedPriceAmount,
      input.lessonPriceCurrency,
      studentId
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed")
    ) {
      response.status(400).render("layout", {
        title: "Duplicate calendar keyword",
        page: "error",
        message: "Calendar keyword is already used by another student.",
      });
      return;
    }

    throw error;
  }

  console.log("student updated", {
    studentId,
    nameRu: input.nameRu,
    nameAr: input.nameAr,
    telegramUsername: input.telegramUsername || null,
    telegramId: input.telegramId,
    calendarKeyword: input.calendarKeyword,
    isActive: input.isActive,
  });

  if (
    student.lesson_price_amount !== updatedPriceAmount ||
    student.lesson_price_currency !== input.lessonPriceCurrency
  ) {
    console.log("lesson price changed", {
      studentId,
      oldAmount: student.lesson_price_amount,
      oldCurrency: student.lesson_price_currency,
      newAmount: updatedPriceAmount,
      newCurrency: input.lessonPriceCurrency,
    });
  }

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

app.get("/calendar", async (_request, response) => {
  const status = getCalendarRuntimeStatus();
  let connected = status.connected;
  let connectionError: string | null = null;

  try {
    connected = await testCalendarConnection();
  } catch (error) {
    connected = false;
    connectionError = error instanceof Error ? error.message : String(error);
  }

  response.render("layout", {
    title: "Calendar",
    page: "calendar",
    calendar: {
      ...status,
      connected,
      connectionError,
    },
  });
});

app.post("/calendar/sync", async (_request, response) => {
  try {
    await syncCalendarLessons();
    response.redirect("/calendar");
  } catch (error) {
    console.error("calendar sync failed from admin", {
      error: error instanceof Error ? error.message : String(error),
    });
    response.status(500).render("layout", {
      title: "Calendar sync failed",
      page: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/lessons", (request, response) => {
  const range = getAdminLessonsRange(request.query);
  const lessons = db
    .prepare(
      `
        SELECT
          lessons.id,
          lessons.title,
          students.name_ru,
          lessons.start_time,
          lessons.status,
          lessons.google_deleted_at,
          lessons.student_response,
          lessons.cancellation_source,
          lessons.awaiting_cancellation_reason,
          lessons.cancellation_reason,
          lessons.cancellation_requested_at,
          lesson_charges.status AS payment_status,
          NULL AS payment_method,
          NULL AS package_used_lessons,
          NULL AS package_total_lessons,
          lesson_charges.amount AS charge_amount,
          lesson_charges.paid_amount AS charge_paid_amount,
          lesson_charges.status AS charge_status,
          latest_payment.receipt_file_path AS receipt_file_path,
          latest_payment.receipt_text AS receipt_text,
          latest_payment.ai_amount AS ai_amount,
          latest_payment.ai_currency AS ai_currency,
          latest_payment.ai_payment_date AS ai_payment_date,
          latest_payment.ai_confidence AS ai_confidence,
          latest_payment.ai_raw_result AS ai_raw_result
        FROM lessons
        LEFT JOIN students ON students.id = lessons.student_id
        LEFT JOIN lesson_charges ON lesson_charges.lesson_id = lessons.id
        LEFT JOIN payment_allocations ON payment_allocations.lesson_charge_id = lesson_charges.id
        LEFT JOIN payments AS latest_payment
          ON latest_payment.id = (
            SELECT payments.id
            FROM payments
            JOIN payment_allocations AS pa ON pa.payment_id = payments.id
            WHERE pa.lesson_charge_id = lesson_charges.id
            ORDER BY payments.paid_at DESC, payments.id DESC
            LIMIT 1
          )
        WHERE (? IS NULL OR date(lessons.start_time) >= date(?))
          AND (? IS NULL OR date(lessons.start_time) <= date(?))
        GROUP BY lessons.id
        ORDER BY lessons.start_time DESC
      `
    )
    .all(
      range.fromDate,
      range.fromDate,
      range.toDate,
      range.toDate
    ) as LessonRow[];

  const viewLessons = lessons.map((lesson) => ({
    ...lesson,
    displayStatus: lesson.google_deleted_at
      ? "deleted from Google Calendar"
      : lesson.status,
    isGoogleDeleted: Boolean(lesson.google_deleted_at),
    formattedStartTime: formatLessonStartTime(lesson.start_time),
    packageProgress:
      lesson.payment_method === "package" &&
      lesson.package_used_lessons !== null &&
      lesson.package_total_lessons !== null
        ? `${lesson.package_used_lessons} / ${lesson.package_total_lessons}`
        : "",
    hasCancellationRequest: buildCancellationRequested(lesson),
    canCancel:
      !lesson.google_deleted_at && isCancellableLessonStatus(lesson.status),
    canComplete:
      !lesson.google_deleted_at && isCancellableLessonStatus(lesson.status),
    canConfirmPayment:
      !lesson.google_deleted_at &&
      !isCancelledLessonStatus(lesson.status) &&
      ["unpaid", "partial"].includes(lesson.payment_status ?? ""),
    aiReceipt: buildAiReceipt(lesson),
  }));

  response.render("layout", {
    title: "Lessons",
    page: "lessons",
    lessons: viewLessons,
    range,
  });
});

app.get("/lessons/:id/cancel", (request, response) => {
  const lessonId = Number(request.params.id);

  if (!Number.isInteger(lessonId) || lessonId <= 0) {
    renderInvalidLesson(response);
    return;
  }

  const lesson = getCancelLesson(lessonId);

  if (!lesson) {
    response.status(404).render("layout", {
      title: "Lesson not found",
      page: "error",
      message: "Lesson not found.",
    });
    return;
  }

  if (completedLessonStatuses.has(lesson.status)) {
    response.status(400).render("layout", {
      title: "Lesson already completed",
      page: "error",
      message: "Completed lessons cannot be cancelled.",
    });
    return;
  }

  if (lesson.google_deleted_at) {
    response.status(400).render("layout", {
      title: "Lesson deleted from Google Calendar",
      page: "error",
      message: "Deleted Google Calendar lessons cannot be cancelled here.",
    });
    return;
  }

  if (isCancelledLessonStatus(lesson.status)) {
    response.status(400).render("layout", {
      title: "Lesson already cancelled",
      page: "error",
      message: "This lesson is already cancelled.",
    });
    return;
  }

  response.render("layout", {
    title: "Cancel lesson",
    page: "lesson-cancel",
    lesson: {
      ...lesson,
      formattedStartTime: formatLessonStartTime(lesson.start_time),
      hasCancellationRequest: buildCancellationRequested(lesson),
      defaultCancellationSource:
        lesson.cancellation_source === "teacher"
          ? "teacher"
          : lesson.cancellation_source === "student" ||
              buildCancellationRequested(lesson)
            ? "student"
            : "",
    },
  });
});

app.post("/lessons/:id/cancel", (request, response) => {
  const lessonId = Number(request.params.id);

  if (!Number.isInteger(lessonId) || lessonId <= 0) {
    renderInvalidLesson(response);
    return;
  }

  const lesson = getCancelLesson(lessonId);

  if (!lesson) {
    response.status(404).render("layout", {
      title: "Lesson not found",
      page: "error",
      message: "Lesson not found.",
    });
    return;
  }

  if (completedLessonStatuses.has(lesson.status)) {
    response.status(400).render("layout", {
      title: "Lesson already completed",
      page: "error",
      message: "Completed lessons cannot be cancelled.",
    });
    return;
  }

  if (lesson.google_deleted_at) {
    response.redirect("/lessons");
    return;
  }

  if (isCancelledLessonStatus(lesson.status)) {
    response.redirect("/lessons");
    return;
  }

  const cancellationSource = String(request.body.cancellation_source ?? "").trim();
  const submittedReason = String(request.body.cancellation_reason ?? "").trim();

  if (!["student", "teacher"].includes(cancellationSource)) {
    response.status(400).render("layout", {
      title: "Invalid cancellation source",
      page: "error",
      message: "Choose who cancelled the lesson.",
    });
    return;
  }

  const cancellationReason = submittedReason || lesson.cancellation_reason || null;

  db.prepare(
    `
      UPDATE lessons
      SET status = 'cancelled',
          cancellation_source = ?,
          cancellation_reason = ?,
          awaiting_cancellation_reason = 0,
          cancellation_requested_at = COALESCE(cancellation_requested_at, datetime('now')),
          cancellation_confirmed_at = datetime('now'),
          cancellation_confirmed_by = 'admin',
          updated_at = datetime('now')
      WHERE id = ?
        AND status != 'completed'
        AND status NOT IN ('cancelled', 'cancelled_by_student', 'cancelled_by_teacher')
    `
  ).run(cancellationSource, cancellationReason, lessonId);

  response.redirect("/lessons");
});

app.post("/lessons/:id/complete", async (request, response) => {
  const lessonId = Number(request.params.id);

  if (!Number.isInteger(lessonId) || lessonId <= 0) {
    renderInvalidLesson(response);
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

app.post("/manual-payments", (request, response) => {
  const studentId = Number(request.body.student_id);
  const amount = Number(request.body.amount);
  const currency = String(request.body.currency ?? "RUB").trim() || "RUB";
  const student = Number.isInteger(studentId)
    ? (db
        .prepare(
          `
            SELECT id
            FROM students
            WHERE id = ?
          `
        )
        .get(studentId) as { id: number } | undefined)
    : undefined;

  if (
    !Number.isInteger(studentId) ||
    studentId <= 0 ||
    !student ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    console.log("manual payment validation failed with submitted body", {
      body: request.body,
    });
    response.status(400).render("layout", {
      title: "Invalid manual payment",
      page: "error",
      message: "Provide a student and a positive payment amount.",
    });
    return;
  }

  const result = addManualStudentPayment(studentId, amount, currency);
  console.log("manual payment created", {
    studentId,
    paymentId: result.paymentId,
    amount: result.amount,
    currency: result.currency,
  });
  console.log("manual payment allocated", {
    studentId,
    paymentId: result.paymentId,
    allocatedAmount: result.allocatedAmount,
    paidLessonsCount: result.paidLessonsCount,
    prepaidAmount: result.prepaidAmount,
    remainingDebtAmount: result.remainingDebtAmount,
  });
  response.redirect("/students");
});

app.post("/manual-debts", (request, response) => {
  const studentId = Number(request.body.student_id);
  const amount = Number(request.body.amount);
  const currency = String(request.body.currency ?? "RUB").trim() || "RUB";
  const note = String(request.body.note ?? "").trim() || null;
  const student = Number.isInteger(studentId) ? getStudentById(studentId) : undefined;

  if (
    !Number.isInteger(studentId) ||
    studentId <= 0 ||
    !student ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    console.log("manual debt validation failed with submitted body", {
      body: request.body,
    });
    response.status(400).render("layout", {
      title: "Invalid manual debt",
      page: "error",
      message: "Provide a student and a positive debt amount.",
    });
    return;
  }

  const charge = createManualCharge(studentId, amount, currency, note);
  const summary = getStudentBalanceSummary(studentId);

  console.log("manual debt created", {
    studentId,
    chargeId: charge.id,
    amount: charge.amount,
    currency: charge.currency,
    note,
  });
  console.log("manual debt balance updated", {
    studentId,
    chargeId: charge.id,
    remainingDebtAmount: summary.unpaid_amount,
    prepaidAmount: summary.prepaid_amount,
  });

  response.redirect("/students");
});

app.listen(port, () => {
  console.log("app mode", {
    appMode,
  });
  console.log("test seed enabled/disabled", {
    enabled:
      String(process.env.ENABLE_TEST_SEED ?? "false").toLowerCase() === "true",
  });
  console.log("calendar sync on web start", {
    enabled: calendarSyncOnWebStart,
  });
  console.log(`Admin server listening on http://localhost:${port}`);

  if (calendarSyncOnWebStart) {
    void syncCalendarLessons().catch((error) => {
      console.error("calendar sync failed on web start", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
});
