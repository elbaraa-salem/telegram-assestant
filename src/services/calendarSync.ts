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
  "confirmed",
  "cancelled_by_teacher",
  "cancelled_by_student",
]);
const defaultLessonMarkers = ["درس", "مذاكرة", "урок", "lesson"];

type Student = {
  id: number;
  calendar_keyword: string;
  name_ru: string;
  name_ar: string;
};

type ExistingLesson = {
  id: number;
  status: string;
  student_id: number | null;
  title: string;
  start_time: string;
  end_time: string;
  google_status: string | null;
};

type MatchedEventDetail = {
  eventId: string;
  title: string;
  startTime: string;
  studentId: number;
  studentName: string;
  matchedKeyword: string;
  lessonMarker: string;
  action: "inserted" | "updated" | "skipped_duplicate" | "skipped_protected";
  lessonId: number | null;
  paymentCreated: boolean;
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
  dryRun: boolean;
  wouldInsertLessons: number;
  wouldUpdateLessons: number;
  wouldCreatePayments: number;
  ignoredEvents: Array<{
    eventId: string | null;
    title: string | null;
    reason: string;
  }>;
  matchedEventDetails: MatchedEventDetail[];
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

function getNonNegativeIntegerEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  const parsedValue = rawValue ? Number.parseInt(rawValue, 10) : NaN;

  return Number.isInteger(parsedValue) && parsedValue >= 0
    ? parsedValue
    : fallback;
}

function createSyncWindow(now = new Date()): SyncWindow {
  const includePastHours = getNonNegativeIntegerEnv(
    "CALENDAR_SYNC_INCLUDE_PAST_HOURS",
    0
  );
  const futureDays = getPositiveIntegerEnv("CALENDAR_SYNC_DAYS_AHEAD", 3);
  const maxResults = getPositiveIntegerEnv("CALENDAR_SYNC_MAX_RESULTS", 250);
  const millisecondsPerHour = 60 * 60 * 1000;
  const millisecondsPerDay = 24 * millisecondsPerHour;

  return {
    timeMin: new Date(
      now.getTime() - includePastHours * millisecondsPerHour
    ).toISOString(),
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

function getLessonMarkers(): string[] {
  const configuredMarkers = process.env.CALENDAR_LESSON_MARKERS
    ?.split(",")
    .map((marker) => normalizeText(marker))
    .filter(Boolean);

  return configuredMarkers?.length
    ? configuredMarkers
    : defaultLessonMarkers.map(normalizeText);
}

function findLessonMarker(title: string, markers: string[]): string | undefined {
  const normalizedTitle = normalizeText(title);
  return markers.find((marker) => normalizedTitle.includes(marker));
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

  return students.find((student) => {
    const matchValues = [
      student.calendar_keyword,
      student.name_ru,
      student.name_ar,
    ]
      .map(normalizeText)
      .filter(Boolean);

    return matchValues.some((value) => normalizedTitle.includes(value));
  });
}

function getMatchedKeyword(title: string, student: Student): string {
  const normalizedTitle = normalizeText(title);
  return [student.calendar_keyword, student.name_ru, student.name_ar].find(
    (value) => value && normalizedTitle.includes(normalizeText(value))
  ) as string;
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
  const lessonMarkers = getLessonMarkers();
  const dryRun = process.env.CALENDAR_SYNC_DRY_RUN === "true";
  const students = db
    .prepare(
      `
        SELECT id, calendar_keyword, name_ru, name_ar
        FROM students
        WHERE is_active = 1
          AND calendar_keyword != ''
        ORDER BY length(calendar_keyword) DESC
      `
    )
    .all() as Student[];

  const existingLessonByGoogleId = db.prepare(
    `
      SELECT id, status, student_id, title, start_time, end_time, google_status
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
    dryRun,
    wouldInsertLessons: 0,
    wouldUpdateLessons: 0,
    wouldCreatePayments: 0,
    ignoredEvents: [],
    matchedEventDetails: [],
  };

  const events = await listUpcomingEvents(calendar, syncWindow);
  result.scannedEvents = events.length;

  const maxLessonsPerStudent = getPositiveIntegerEnv(
    "CALENDAR_SYNC_MAX_LESSONS_PER_STUDENT",
    Number.MAX_SAFE_INTEGER
  );
  const importedLessonsPerStudent = new Map<number, number>();

  const syncEvent = (event: calendar_v3.Schema$Event) => {
    const googleEventId = event.id;
    const title = event.summary?.trim();
    const startTime = getEventTime(event.start);
    const endTime = getEventTime(event.end);

    if (!googleEventId || !title || !startTime || !endTime) {
      result.ignoredEvents.push({
        eventId: googleEventId ?? null,
        title: title ?? null,
        reason: "missing id, title, or time",
      });
      return;
    }

    const student = findMatchingStudent(title, students);

    if (!student) {
      result.ignoredEvents.push({
        eventId: googleEventId,
        title,
        reason: "no matching student keyword",
      });
      return;
    }

    const lessonMarker = findLessonMarker(title, lessonMarkers);

    if (!lessonMarker) {
      result.ignoredEvents.push({
        eventId: googleEventId,
        title,
        reason: "missing lesson marker",
      });
      return;
    }

    const importedForStudent = importedLessonsPerStudent.get(student.id) ?? 0;
    if (importedForStudent >= maxLessonsPerStudent) {
      result.ignoredEvents.push({
        eventId: googleEventId,
        title,
        reason: "max lessons per student reached",
      });
      return;
    }

    importedLessonsPerStudent.set(student.id, importedForStudent + 1);
    result.matchedEvents += 1;

    const existingLesson = existingLessonByGoogleId.get(
      googleEventId
    ) as ExistingLesson | undefined;

    const googleStatus = event.status ?? null;
    const updatedAt = new Date().toISOString();
    let lessonId: number;
    let paymentStudentId = student.id;
    let action: MatchedEventDetail["action"];
    let paymentCreated = false;

    if (existingLesson) {
      lessonId = existingLesson.id;
      paymentStudentId = existingLesson.student_id ?? student.id;

      if (protectedLessonStatuses.has(existingLesson.status)) {
        result.skippedProtectedLessons += 1;
        action = "skipped_protected";
      } else if (
        existingLesson.student_id === student.id &&
        existingLesson.title === title &&
        existingLesson.start_time === startTime &&
        existingLesson.end_time === endTime &&
        existingLesson.google_status === googleStatus
      ) {
        action = "skipped_duplicate";
      } else {
        action = "updated";
        result.wouldUpdateLessons += 1;
        if (!dryRun) {
          updateLesson.run(
            student.id,
            title,
            startTime,
            endTime,
            googleStatus,
            updatedAt,
            lessonId
          );
        }
        paymentStudentId = student.id;
        if (!dryRun) {
          result.updatedLessons += 1;
        }
      }
    } else {
      const status = "scheduled";

      result.wouldInsertLessons += 1;
      if (dryRun) {
        result.wouldCreatePayments += 1;
        result.matchedEventDetails.push({
          eventId: googleEventId,
          title,
          startTime,
          studentId: student.id,
          studentName: student.name_ru || student.name_ar,
          matchedKeyword: getMatchedKeyword(title, student),
          lessonMarker,
          action: "inserted",
          lessonId: null,
          paymentCreated: true,
        });
        return;
      }

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
      action = "inserted";
    }

    const existingPayment = db
      .prepare("SELECT id FROM payments WHERE lesson_id = ?")
      .get(lessonId);

    if (!existingPayment) {
      result.wouldCreatePayments += 1;
      if (!dryRun) {
        const paymentResult = insertPayment.run(lessonId, paymentStudentId);
        result.createdPayments += paymentResult.changes;
        paymentCreated = paymentResult.changes > 0;
      }
    }

    result.matchedEventDetails.push({
      eventId: googleEventId,
      title,
      startTime,
      studentId: student.id,
      studentName: student.name_ru || student.name_ar,
      matchedKeyword: getMatchedKeyword(title, student),
      lessonMarker,
      action,
      lessonId,
      paymentCreated,
    });
  };

  if (dryRun) {
    for (const event of events) {
      syncEvent(event);
    }
  } else {
    const syncEvents = db.transaction((calendarEvents: calendar_v3.Schema$Event[]) => {
      for (const event of calendarEvents) {
        syncEvent(event);
      }
    });

    syncEvents(events);
  }

  return result;
}

async function main() {
  try {
    const result = await syncCalendarLessons();
    console.log("Calendar sync completed:");
    const { ignoredEvents, matchedEventDetails, ...summary } = result;
    console.log({
      ...summary,
      ignoredEventCount: ignoredEvents.length,
    });

    if (process.env.CALENDAR_SYNC_VERBOSE_IGNORED === "true") {
      console.log({ ignoredEvents });
    }

    if (process.env.CALENDAR_SYNC_VERBOSE_MATCHED === "true") {
      console.log({ matchedEventDetails });
    }
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
