import "dotenv/config";
import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  timeMin: string;
  timeMax: string;
  scannedEvents: number;
  matchedEvents: number;
  insertedLessons: number;
  updatedLessons: number;
  skippedProtectedLessons: number;
  createdPayments: number;
};

type SyncWindow = {
  timeMin: string;
  timeMax: string;
  maxResults: number;
};

function getPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  const parsedValue = rawValue ? Number.parseInt(rawValue, 10) : NaN;

  return Number.isInteger(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallback;
}

function createSyncWindow(now = new Date()): SyncWindow {
  const pastDays = getPositiveIntegerEnv("CALENDAR_SYNC_PAST_DAYS", 1);
  const futureDays = getPositiveIntegerEnv("CALENDAR_SYNC_FUTURE_DAYS", 45);
  const maxResults = getPositiveIntegerEnv("CALENDAR_SYNC_MAX_RESULTS", 250);
  const millisecondsPerDay = 24 * 60 * 60 * 1000;

  return {
    timeMin: new Date(now.getTime() - pastDays * millisecondsPerDay).toISOString(),
    timeMax: new Date(
      now.getTime() + futureDays * millisecondsPerDay
    ).toISOString(),
    maxResults,
  };
}

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
  calendar: calendar_v3.Calendar,
  syncWindow: SyncWindow
): Promise<calendar_v3.Schema$Event[]> {
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;

  do {
    const response = await calendar.events.list({
      calendarId: "primary",
      singleEvents: true,
      showDeleted: true,
      orderBy: "startTime",
      timeMin: syncWindow.timeMin,
      timeMax: syncWindow.timeMax,
      maxResults: syncWindow.maxResults,
      pageToken,
    });

    events.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return events;
}

export async function syncCalendarLessons(): Promise<SyncResult> {
  const calendar = createCalendarClient();
  const syncWindow = createSyncWindow();
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
    timeMin: syncWindow.timeMin,
    timeMax: syncWindow.timeMax,
    scannedEvents: 0,
    matchedEvents: 0,
    insertedLessons: 0,
    updatedLessons: 0,
    skippedProtectedLessons: 0,
    createdPayments: 0,
  };

  const events = await listUpcomingEvents(calendar, syncWindow);
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
  try {
    const result = await syncCalendarLessons();
    console.log("Calendar sync completed:");
    console.log(result);
  } catch (error) {
    console.error("Calendar sync failed:");
    console.error(error);
    process.exit(1);
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (currentFilePath === executedFilePath) {
  void main();
}
