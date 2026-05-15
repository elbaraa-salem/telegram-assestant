import fs from "fs";
import path from "path";
import { google, calendar_v3 } from "googleapis";
import { db } from "../database/db";

const credentialsPath = path.join(
  process.cwd(),
  "config",
  "google-credentials.json"
);

const tokenPath = path.join(process.cwd(), "config", "google-token.json");

const protectedLessonStatuses = new Set([
  "completed",
  "cancelled_by_teacher",
  "cancelled_by_student",
]);

type Student = {
  id: number;
  calendar_keyword: string;
};

type ExistingLesson = {
  id: number;
  status: string;
  student_id: number | null;
};

type SyncResult = {
  scannedEvents: number;
  matchedEvents: number;
  insertedLessons: number;
  updatedLessons: number;
  skippedProtectedLessons: number;
  createdPayments: number;
};

function createCalendarClient(): calendar_v3.Calendar {
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  const tokens = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  const clientInfo = credentials.installed;

  const oauth2Client = new google.auth.OAuth2(
    clientInfo.client_id,
    clientInfo.client_secret,
    clientInfo.redirect_uris[0]
  );

  oauth2Client.setCredentials(tokens);

  return google.calendar({
    version: "v3",
    auth: oauth2Client,
  });
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function getEventTime(value?: calendar_v3.Schema$EventDateTime): string | null {
  if (value?.dateTime) {
    return value.dateTime;
  }

  if (value?.date) {
    return new Date(value.date).toISOString();
  }

  return null;
}

function findMatchingStudent(
  title: string,
  students: Student[]
): Student | undefined {
  const normalizedTitle = normalizeText(title);

  return students.find((student) =>
    normalizedTitle.includes(normalizeText(student.calendar_keyword))
  );
}

async function listUpcomingEvents(
  calendar: calendar_v3.Calendar
): Promise<calendar_v3.Schema$Event[]> {
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;

  do {
    const response = await calendar.events.list({
      calendarId: "primary",
      singleEvents: true,
      showDeleted: true,
      orderBy: "startTime",
      timeMin: new Date().toISOString(),
      pageToken,
    });

    events.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return events;
}

export async function syncUpcomingCalendarLessons(): Promise<SyncResult> {
  const calendar = createCalendarClient();
  const students = db
    .prepare(
      `
        SELECT id, calendar_keyword
        FROM students
        WHERE is_active = 1
          AND calendar_keyword != ''
        ORDER BY length(calendar_keyword) DESC
      `
    )
    .all() as Student[];

  const existingLessonByGoogleId = db.prepare(
    `
      SELECT id, status, student_id
      FROM lessons
      WHERE google_event_id = ?
    `
  );

  const insertLesson = db.prepare(
    `
      INSERT INTO lessons (
        google_event_id,
        student_id,
        title,
        start_time,
        end_time,
        status,
        google_status,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  );

  const updateLesson = db.prepare(
    `
      UPDATE lessons
      SET student_id = ?,
          title = ?,
          start_time = ?,
          end_time = ?,
          google_status = ?,
          updated_at = ?
      WHERE id = ?
    `
  );

  const insertPayment = db.prepare(
    `
      INSERT OR IGNORE INTO payments (
        lesson_id,
        student_id
      )
      VALUES (?, ?)
    `
  );

  const result: SyncResult = {
    scannedEvents: 0,
    matchedEvents: 0,
    insertedLessons: 0,
    updatedLessons: 0,
    skippedProtectedLessons: 0,
    createdPayments: 0,
  };

  const events = await listUpcomingEvents(calendar);
  result.scannedEvents = events.length;

  const syncEvent = db.transaction((event: calendar_v3.Schema$Event) => {
    const googleEventId = event.id;
    const title = event.summary?.trim();
    const startTime = getEventTime(event.start);
    const endTime = getEventTime(event.end);

    if (!googleEventId || !title || !startTime || !endTime) {
      return;
    }

    const student = findMatchingStudent(title, students);

    if (!student) {
      return;
    }

    result.matchedEvents += 1;

    const existingLesson = existingLessonByGoogleId.get(
      googleEventId
    ) as ExistingLesson | undefined;

    const googleStatus = event.status ?? null;
    const updatedAt = new Date().toISOString();
    let lessonId: number;
    let paymentStudentId = student.id;

    if (existingLesson) {
      lessonId = existingLesson.id;
      paymentStudentId = existingLesson.student_id ?? student.id;

      if (protectedLessonStatuses.has(existingLesson.status)) {
        result.skippedProtectedLessons += 1;
      } else {
        updateLesson.run(
          student.id,
          title,
          startTime,
          endTime,
          googleStatus,
          updatedAt,
          lessonId
        );
        paymentStudentId = student.id;
        result.updatedLessons += 1;
      }
    } else {
      const status =
        googleStatus === "cancelled" ? "cancelled_unknown" : "scheduled";

      const insertResult = insertLesson.run(
        googleEventId,
        student.id,
        title,
        startTime,
        endTime,
        status,
        googleStatus,
        updatedAt
      );

      lessonId = Number(insertResult.lastInsertRowid);
      result.insertedLessons += 1;
    }

    const paymentResult = insertPayment.run(lessonId, paymentStudentId);
    result.createdPayments += paymentResult.changes;
  });

  for (const event of events) {
    syncEvent(event);
  }

  return result;
}

async function main() {
  const result = await syncUpcomingCalendarLessons();
  console.log(result);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Calendar sync failed:", error);
    process.exit(1);
  });
}
