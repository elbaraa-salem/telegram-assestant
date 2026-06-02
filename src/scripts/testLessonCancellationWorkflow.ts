import assert from "node:assert/strict";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const tempDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "telegram-assistant-cancel-test-")
);
const port = 31_457;
const serverPath = path.join(repoRoot, "src/web/server.ts");
const tsxPath = path.join(repoRoot, "node_modules/.bin/tsx");
const baseUrl = `http://127.0.0.1:${port}`;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServer(
  server: ChildProcessWithoutNullStreams
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8_000) {
    if (server.exitCode !== null) {
      throw new Error(`admin server exited with code ${server.exitCode}`);
    }

    try {
      const response = await fetch(`${baseUrl}/lessons`);

      if (response.ok) {
        return;
      }
    } catch {
      await wait(100);
    }
  }

  throw new Error("admin server did not start in time");
}

function postForm(pathname: string, body: URLSearchParams): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    redirect: "manual",
  });
}

process.chdir(tempDir);

const { db } = await import("../database/db");

const studentId = Number(
  db
    .prepare(
      `
        INSERT INTO students (
          name_ru,
          name_ar,
          calendar_keyword,
          lesson_price_amount,
          lesson_price_currency,
          is_active,
          created_at
        )
        VALUES ('Test Student', 'طالب', 'cancel-test', 1000, 'RUB', 1, datetime('now'))
      `
    )
    .run().lastInsertRowid
);
const accountingStudentId = Number(
  db
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
          is_active,
          created_at
        )
        VALUES ('Accounting Student', 'طالب محاسبة', '@accounting_old', '10001', 'accounting-test', 1000, 'RUB', 1, datetime('now'))
      `
    )
    .run().lastInsertRowid
);

function insertLesson(input: {
  eventId: string;
  studentId?: number;
  status?: string;
  googleDeletedAt?: string | null;
  cancellationReason?: string | null;
  cancellationRequestedAt?: string | null;
  startModifier?: string;
}): number {
  return Number(
    db
      .prepare(
        `
          INSERT INTO lessons (
            google_event_id,
            student_id,
            title,
            start_time,
            end_time,
            status,
            google_deleted_at,
            cancellation_reason,
            cancellation_requested_at,
            updated_at
          )
          VALUES (?, ?, 'Cancellation workflow lesson', datetime('now', ?), datetime('now', ?, '+1 hour'), ?, ?, ?, ?, datetime('now'))
        `
      )
      .run(
        input.eventId,
        input.studentId ?? studentId,
        input.startModifier ?? "+1 day",
        input.startModifier ?? "+1 day",
        input.status ?? "scheduled",
        input.googleDeletedAt ?? null,
        input.cancellationReason ?? null,
        input.cancellationRequestedAt ?? null
      ).lastInsertRowid
  );
}

const scheduledLessonId = insertLesson({ eventId: "scheduled-cancel-test" });
const requestedLessonId = insertLesson({
  eventId: "requested-cancel-test",
  cancellationReason: "University exam",
  cancellationRequestedAt: new Date().toISOString(),
});
const teacherLessonId = insertLesson({ eventId: "teacher-cancel-test" });
const cancelledLessonId = insertLesson({
  eventId: "already-cancelled-test",
  status: "cancelled",
});
const oldHiddenLessonId = insertLesson({
  eventId: "old-hidden-test",
  startModifier: "-10 days",
});
const futureHiddenLessonId = insertLesson({
  eventId: "future-hidden-test",
  startModifier: "+10 days",
});
const completedVisibleLessonId = insertLesson({
  eventId: "completed-visible-test",
  status: "completed",
  startModifier: "-1 day",
});
const cancelledVisibleLessonId = insertLesson({
  eventId: "cancelled-visible-test",
  status: "cancelled",
  startModifier: "+1 day",
});
const googleDeletedVisibleLessonId = insertLesson({
  eventId: "google-deleted-visible-test",
  status: "scheduled",
  googleDeletedAt: new Date().toISOString(),
  startModifier: "+1 day",
});

const server = spawn(tsxPath, [serverPath], {
  cwd: tempDir,
  env: {
    ...process.env,
    ADMIN_PORT: String(port),
    TG_API_ID: process.env.TG_API_ID ?? "1",
    TG_API_HASH: process.env.TG_API_HASH ?? "test-api-hash",
    TG_PHONE: process.env.TG_PHONE ?? "+10000000000",
    MANAGE_SPEND_BOT_NOTIFICATIONS_ENABLED: "false",
    STUDENT_WELCOME_MESSAGE_ENABLED: "false",
  },
});

let stderr = "";
server.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
});

try {
  await waitForServer(server);

  const editHtml = await (
    await fetch(`${baseUrl}/students/${accountingStudentId}/edit`)
  ).text();
  assert.match(editHtml, /Edit student/);

  await postForm(
    `/students/${accountingStudentId}/edit`,
    new URLSearchParams({
      name_ru: "Accounting Student Updated",
      name_ar: "طالب محاسبة جديد",
      telegram_username: "@accounting_new",
      telegram_id: "20002",
      calendar_keyword: "accounting-updated",
      is_active: "1",
      lesson_price_amount: "1500",
      lesson_price_currency: "RUB",
    })
  );
  const editedStudent = db
    .prepare(
      `
        SELECT
          name_ru,
          name_ar,
          telegram_username,
          telegram_id,
          calendar_keyword,
          is_active,
          lesson_price_amount,
          lesson_price_currency
        FROM students
        WHERE id = ?
      `
    )
    .get(accountingStudentId) as {
    name_ru: string;
    name_ar: string;
    telegram_username: string;
    telegram_id: string;
    calendar_keyword: string;
    is_active: number;
    lesson_price_amount: number;
    lesson_price_currency: string;
  };
  assert.equal(editedStudent.name_ru, "Accounting Student Updated");
  assert.equal(editedStudent.name_ar, "طالب محاسبة جديد");
  assert.equal(editedStudent.telegram_username, "@accounting_new");
  assert.equal(editedStudent.telegram_id, "20002");
  assert.equal(editedStudent.calendar_keyword, "accounting-updated");
  assert.equal(editedStudent.is_active, 1);
  assert.equal(editedStudent.lesson_price_amount, 1500);
  assert.equal(editedStudent.lesson_price_currency, "RUB");

  db.prepare(
    `
      UPDATE students
      SET lesson_price_amount = 1000
      WHERE id = ?
    `
  ).run(accountingStudentId);
  const oldPriceLessonId = insertLesson({
    eventId: "old-price-lesson",
    studentId: accountingStudentId,
  });
  const { createLessonChargeForCompletedLesson } = await import(
    "../services/paymentBalanceService"
  );
  const oldCharge = createLessonChargeForCompletedLesson(oldPriceLessonId);
  assert.equal(oldCharge?.amount, 1000);

  await postForm(
    `/students/${accountingStudentId}/edit`,
    new URLSearchParams({
      name_ru: "Accounting Student Updated",
      name_ar: "طالب محاسبة جديد",
      telegram_username: "@accounting_new",
      telegram_id: "20002",
      calendar_keyword: "accounting-updated",
      is_active: "1",
      lesson_price_amount: "1500",
      lesson_price_currency: "RUB",
    })
  );
  const futurePriceLessonId = insertLesson({
    eventId: "future-price-lesson",
    studentId: accountingStudentId,
  });
  const futureCharge = createLessonChargeForCompletedLesson(futurePriceLessonId);
  assert.equal(futureCharge?.amount, 1500);
  const preservedOldCharge = db
    .prepare("SELECT amount FROM lesson_charges WHERE lesson_id = ?")
    .get(oldPriceLessonId) as { amount: number };
  assert.equal(preservedOldCharge.amount, 1000);

  const lessonsHtml = await (await fetch(`${baseUrl}/lessons`)).text();
  assert.match(
    lessonsHtml,
    new RegExp(`/lessons/${scheduledLessonId}/cancel`),
    "scheduled lesson should show a cancel action"
  );
  assert.match(
    lessonsHtml,
    /Student requested cancellation/,
    "student cancellation request should be highlighted"
  );
  assert.match(
    lessonsHtml,
    /University exam/,
    "student cancellation reason should be visible"
  );
  assert.match(
    lessonsHtml,
    /Showing lessons from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/,
    "default lessons page should show selected date range text"
  );
  assert.doesNotMatch(
    lessonsHtml,
    new RegExp(`<td>${oldHiddenLessonId}</td>`),
    "lessons before previous 7 days should be hidden by default"
  );
  assert.doesNotMatch(
    lessonsHtml,
    new RegExp(`<td>${futureHiddenLessonId}</td>`),
    "lessons after next 7 days should be hidden by default"
  );
  assert.match(
    lessonsHtml,
    new RegExp(`<td>${completedVisibleLessonId}</td>`),
    "completed lessons inside range should be shown"
  );
  assert.match(
    lessonsHtml,
    new RegExp(`<td>${cancelledVisibleLessonId}</td>`),
    "cancelled lessons inside range should be shown"
  );
  assert.match(
    lessonsHtml,
    new RegExp(`<td>${googleDeletedVisibleLessonId}</td>[\\s\\S]*Deleted from Google Calendar`),
    "google-deleted lessons should be marked in admin"
  );
  assert.doesNotMatch(
    lessonsHtml,
    new RegExp(`/lessons/${googleDeletedVisibleLessonId}/complete`),
    "google-deleted lessons should not show complete action"
  );
  assert.doesNotMatch(
    lessonsHtml,
    new RegExp(`/lessons/${googleDeletedVisibleLessonId}/cancel`),
    "google-deleted lessons should not show cancel action"
  );

  const requestedCancelHtml = await (
    await fetch(`${baseUrl}/lessons/${requestedLessonId}/cancel`)
  ).text();
  assert.match(
    requestedCancelHtml,
    /value="student"[\s\S]*checked/,
    "existing student request should default to student source"
  );

  await postForm(
    `/lessons/${requestedLessonId}/cancel`,
    new URLSearchParams({
      cancellation_source: "student",
      cancellation_reason: "",
    })
  );
  const studentCancelled = db
    .prepare(
      `
        SELECT status, cancellation_source, cancellation_reason
        FROM lessons
        WHERE id = ?
      `
    )
    .get(requestedLessonId) as {
    status: string;
    cancellation_source: string;
    cancellation_reason: string;
  };
  assert.equal(studentCancelled.status, "cancelled");
  assert.equal(studentCancelled.cancellation_source, "student");
  assert.equal(studentCancelled.cancellation_reason, "University exam");

  await postForm(
    `/lessons/${teacherLessonId}/cancel`,
    new URLSearchParams({
      cancellation_source: "teacher",
      cancellation_reason: "Teacher unavailable",
    })
  );
  const teacherCancelled = db
    .prepare(
      `
        SELECT status, cancellation_source, cancellation_reason
        FROM lessons
        WHERE id = ?
      `
    )
    .get(teacherLessonId) as {
    status: string;
    cancellation_source: string;
    cancellation_reason: string;
  };
  assert.equal(teacherCancelled.status, "cancelled");
  assert.equal(teacherCancelled.cancellation_source, "teacher");
  assert.equal(teacherCancelled.cancellation_reason, "Teacher unavailable");

  await postForm(`/lessons/${cancelledLessonId}/complete`, new URLSearchParams());
  const completedAttempt = db
    .prepare("SELECT status FROM lessons WHERE id = ?")
    .get(cancelledLessonId) as { status: string };
  assert.equal(completedAttempt.status, "cancelled");

  const cancelledCharges = db
    .prepare("SELECT COUNT(*) AS count FROM lesson_charges WHERE lesson_id = ?")
    .get(cancelledLessonId) as { count: number };
  assert.equal(cancelledCharges.count, 0);

  const manualDebtStudentId = Number(
    db
      .prepare(
        `
          INSERT INTO students (
            name_ru,
            name_ar,
            calendar_keyword,
            lesson_price_amount,
            lesson_price_currency,
            is_active,
            created_at
          )
          VALUES ('Manual Debt Student', 'طالب دين', 'manual-debt-test', 1000, 'RUB', 1, datetime('now'))
        `
      )
      .run().lastInsertRowid
  );
  await postForm(
    "/manual-debts",
    new URLSearchParams({
      student_id: String(manualDebtStudentId),
      amount: "2000",
      currency: "RUB",
      note: "Manual accounting adjustment",
    })
  );
  const manualCharge = db
    .prepare(
      `
        SELECT lesson_id, charge_type, amount, status, paid_amount, note
        FROM lesson_charges
        WHERE student_id = ?
      `
    )
    .get(manualDebtStudentId) as {
    lesson_id: number | null;
    charge_type: string;
    amount: number;
    status: string;
    paid_amount: number;
    note: string;
  };
  assert.equal(manualCharge.lesson_id, null);
  assert.equal(manualCharge.charge_type, "manual");
  assert.equal(manualCharge.amount, 2000);
  assert.equal(manualCharge.status, "unpaid");
  assert.equal(manualCharge.note, "Manual accounting adjustment");

  let manualDebtSummary = db
    .prepare(
      `
        SELECT
          COALESCE(SUM(amount - paid_amount), 0) AS unpaid_amount
        FROM lesson_charges
        WHERE student_id = ?
          AND status IN ('unpaid', 'partial')
      `
    )
    .get(manualDebtStudentId) as { unpaid_amount: number };
  assert.equal(manualDebtSummary.unpaid_amount, 2000);

  await postForm(
    "/manual-payments",
    new URLSearchParams({
      student_id: String(manualDebtStudentId),
      amount: "5000",
      currency: "RUB",
    })
  );
  const paidManualCharge = db
    .prepare(
      `
        SELECT status, paid_amount
        FROM lesson_charges
        WHERE student_id = ?
          AND charge_type = 'manual'
      `
    )
    .get(manualDebtStudentId) as {
    status: string;
    paid_amount: number;
  };
  assert.equal(paidManualCharge.status, "paid");
  assert.equal(paidManualCharge.paid_amount, 2000);

  const { getStudentBalanceSummary } = await import(
    "../services/paymentBalanceService"
  );
  manualDebtSummary = db
    .prepare(
      `
        SELECT
          COALESCE(SUM(amount - paid_amount), 0) AS unpaid_amount
        FROM lesson_charges
        WHERE student_id = ?
          AND status IN ('unpaid', 'partial')
      `
    )
    .get(manualDebtStudentId) as { unpaid_amount: number };
  const balanceAfterManualDebtPayment =
    getStudentBalanceSummary(manualDebtStudentId);
  assert.equal(manualDebtSummary.unpaid_amount, 0);
  assert.equal(balanceAfterManualDebtPayment.prepaid_amount, 3000);
  assert.equal(balanceAfterManualDebtPayment.prepaid_lessons_count, 3);

  const stats = db
    .prepare(
      `
        SELECT cancellation_source, COUNT(*) AS count
        FROM lessons
        WHERE status = 'cancelled'
        GROUP BY cancellation_source
      `
    )
    .all() as Array<{ cancellation_source: string | null; count: number }>;
  assert.ok(
    stats.some(
      (row) => row.cancellation_source === "student" && row.count >= 1
    )
  );
  assert.ok(
    stats.some(
      (row) => row.cancellation_source === "teacher" && row.count >= 1
    )
  );

  console.log("Lesson cancellation workflow checks passed.");
} finally {
  server.kill();
  await wait(100);

  if (server.exitCode === 1 && stderr) {
    console.error(stderr);
  }

  db.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}
