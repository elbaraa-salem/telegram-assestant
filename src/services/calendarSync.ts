import "dotenv/config";
import fs from "fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google, calendar_v3 } from "googleapis";
import { db } from "../database/db";

const serviceAccountDefaultPath = path.join(
  process.cwd(),
  "config",
  "google-service-account.json"
);
const calendarReadonlyScopes = ["https://www.googleapis.com/auth/calendar.readonly"];

const protectedLessonStatuses = new Set([
  "completed",
  "confirmed",
  "cancelled",
  "cancelled_by_teacher",
  "cancelled_by_student",
]);
const defaultLessonMarkers = ["درس", "مذاكرة", "урок", "lesson"];
const invalidGoogleTokenMessage =
  "Google token is invalid or expired. Run npm run google:auth.";

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

type LocalSyncedLesson = {
  id: number;
  google_event_id: string;
  status: string;
  reminder_sent: number;
  payment_request_sent: number;
  student_response: string | null;
  student_response_at: string | null;
  cancellation_source: string | null;
  awaiting_cancellation_reason: number;
  cancellation_reason: string | null;
  cancellation_requested_at: string | null;
  cancellation_confirmed_at: string | null;
  ai_cancellation_confidence: number | null;
  charge_count: number;
  payment_count: number;
  allocation_count: number;
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
  deletedUntouchedLessons: number;
  preservedDeletedCalendarLessons: number;
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

export type CalendarAuthMode = "oauth" | "service_account";

export type CalendarRuntimeStatus = {
  authMode: CalendarAuthMode;
  calendarId: string;
  connected: boolean;
  lastSyncTime: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastInsertedLessons: number;
  lastUpdatedLessons: number;
  lastSkippedProtectedLessons: number;
  lastDeletedUntouchedLessons: number;
  lastPreservedDeletedCalendarLessons: number;
};

export type SyncCalendarOptions = {
  studentId?: number;
  events?: calendar_v3.Schema$Event[];
};

export function isInvalidGrantError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return String(error).includes("invalid_grant");
  }

  const candidate = error as {
    message?: unknown;
    response?: {
      data?: unknown;
    };
  };

  return (
    String(candidate.message ?? "").includes("invalid_grant") ||
    JSON.stringify(candidate.response?.data ?? {}).includes("invalid_grant")
  );
}

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
  const lookbackDays = getNonNegativeIntegerEnv(
    "CALENDAR_SYNC_LOOKBACK_DAYS",
    getNonNegativeIntegerEnv("CALENDAR_SYNC_INCLUDE_PAST_HOURS", 0) / 24
  );
  const futureDays = getPositiveIntegerEnv(
    "CALENDAR_SYNC_LOOKAHEAD_DAYS",
    getPositiveIntegerEnv("CALENDAR_SYNC_DAYS_AHEAD", 30)
  );
  const maxResults = getPositiveIntegerEnv("CALENDAR_SYNC_MAX_RESULTS", 250);
  const millisecondsPerDay = 24 * 60 * 60 * 1000;

  return {
    timeMin: new Date(
      now.getTime() - lookbackDays * millisecondsPerDay
    ).toISOString(),
    timeMax: new Date(
      now.getTime() + futureDays * millisecondsPerDay
    ).toISOString(),
    maxResults,
  };
}

export function getCalendarAuthMode(): CalendarAuthMode {
  const authMode = process.env.GOOGLE_AUTH_MODE?.trim() || "oauth";

  return authMode === "service_account" ? "service_account" : "oauth";
}

export function getCalendarId(): string {
  return process.env.GOOGLE_CALENDAR_ID?.trim() || "primary";
}

function getGoogleCredentialsPath(): string {
  return (
    process.env.GOOGLE_CREDENTIALS_FILE?.trim() ||
    path.join(process.cwd(), "config", "google-credentials.json")
  );
}

function getGoogleTokenPath(): string {
  return (
    process.env.GOOGLE_TOKEN_FILE?.trim() ||
    path.join(process.cwd(), "config", "google-token.json")
  );
}

function createCalendarClient(): calendar_v3.Calendar {
  const authMode = getCalendarAuthMode();

  console.log("calendar auth mode", { authMode });

  if (authMode === "service_account") {
    const keyFile =
      process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim() ||
      serviceAccountDefaultPath;
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: calendarReadonlyScopes,
    });

    return google.calendar({
      version: "v3",
      auth,
    });
  }

  const credentials = JSON.parse(
    fs.readFileSync(getGoogleCredentialsPath(), "utf8")
  );
  const tokens = JSON.parse(fs.readFileSync(getGoogleTokenPath(), "utf8"));
  const clientInfo = credentials.installed ?? credentials.web;

  if (!clientInfo) {
    throw new Error("Missing installed or web OAuth client in Google credentials");
  }

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
  const calendarId = getCalendarId();

  do {
    const response = await calendar.events.list({
      calendarId,
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

function getSetting(key: string): string | null {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;

  return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
  db.prepare(
    `
      INSERT INTO app_settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `
  ).run(key, value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function saveCalendarSyncStatus(
  status: "success" | "failed",
  result: SyncResult | null,
  error: unknown = null
): void {
  setSetting("calendar.last_sync_time", new Date().toISOString());
  setSetting("calendar.last_sync_status", status);
  setSetting("calendar.last_sync_error", error ? getErrorMessage(error) : "");
  setSetting(
    "calendar.last_inserted_lessons",
    String(result?.insertedLessons ?? 0)
  );
  setSetting("calendar.last_updated_lessons", String(result?.updatedLessons ?? 0));
  setSetting(
    "calendar.last_skipped_protected_lessons",
    String(result?.skippedProtectedLessons ?? 0)
  );
  setSetting(
    "calendar.last_deleted_untouched_lessons",
    String(result?.deletedUntouchedLessons ?? 0)
  );
  setSetting(
    "calendar.last_preserved_deleted_calendar_lessons",
    String(result?.preservedDeletedCalendarLessons ?? 0)
  );
}

export function getCalendarRuntimeStatus(): CalendarRuntimeStatus {
  return {
    authMode: getCalendarAuthMode(),
    calendarId: getCalendarId(),
    connected: getSetting("calendar.last_sync_status") === "success",
    lastSyncTime: getSetting("calendar.last_sync_time"),
    lastSyncStatus: getSetting("calendar.last_sync_status"),
    lastSyncError: getSetting("calendar.last_sync_error"),
    lastInsertedLessons: Number(getSetting("calendar.last_inserted_lessons") ?? 0),
    lastUpdatedLessons: Number(getSetting("calendar.last_updated_lessons") ?? 0),
    lastSkippedProtectedLessons: Number(
      getSetting("calendar.last_skipped_protected_lessons") ?? 0
    ),
    lastDeletedUntouchedLessons: Number(
      getSetting("calendar.last_deleted_untouched_lessons") ?? 0
    ),
    lastPreservedDeletedCalendarLessons: Number(
      getSetting("calendar.last_preserved_deleted_calendar_lessons") ?? 0
    ),
  };
}

function eventIsActive(event: calendar_v3.Schema$Event): boolean {
  return Boolean(
    event.id &&
      event.status !== "cancelled" &&
      event.summary?.trim() &&
      getEventTime(event.start) &&
      getEventTime(event.end)
  );
}

function lessonIsUntouched(lesson: LocalSyncedLesson): boolean {
  return (
    lesson.status === "scheduled" &&
    lesson.reminder_sent === 0 &&
    lesson.payment_request_sent === 0 &&
    !lesson.student_response &&
    !lesson.student_response_at &&
    !lesson.cancellation_source &&
    lesson.awaiting_cancellation_reason === 0 &&
    !lesson.cancellation_reason &&
    !lesson.cancellation_requested_at &&
    !lesson.cancellation_confirmed_at &&
    lesson.ai_cancellation_confidence === null &&
    lesson.charge_count === 0 &&
    lesson.payment_count === 0 &&
    lesson.allocation_count === 0
  );
}

export async function testCalendarConnection(): Promise<boolean> {
  const calendar = createCalendarClient();
  await calendar.events.list({
    calendarId: getCalendarId(),
    maxResults: 1,
    singleEvents: true,
  });

  return true;
}

export async function syncCalendarLessons(
  options: SyncCalendarOptions = {}
): Promise<SyncResult> {
  console.log("calendar sync started", {
    authMode: getCalendarAuthMode(),
    calendarId: getCalendarId(),
    studentId: options.studentId ?? null,
  });

  try {
  const calendar = options.events ? null : createCalendarClient();
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
          AND (? IS NULL OR id = ?)
        ORDER BY length(calendar_keyword) DESC
      `
    )
    .all(options.studentId ?? null, options.studentId ?? null) as Student[];

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
  const findLocalSyncedLessonsInWindow = db.prepare(
    `
      SELECT
        lessons.id,
        lessons.google_event_id,
        lessons.status,
        lessons.reminder_sent,
        lessons.payment_request_sent,
        lessons.student_response,
        lessons.student_response_at,
        lessons.cancellation_source,
        lessons.awaiting_cancellation_reason,
        lessons.cancellation_reason,
        lessons.cancellation_requested_at,
        lessons.cancellation_confirmed_at,
        lessons.ai_cancellation_confidence,
        COUNT(DISTINCT lesson_charges.id) AS charge_count,
        COUNT(DISTINCT direct_payments.id) AS payment_count,
        COUNT(DISTINCT payment_allocations.id) AS allocation_count
      FROM lessons
      LEFT JOIN lesson_charges ON lesson_charges.lesson_id = lessons.id
      LEFT JOIN payments AS direct_payments ON direct_payments.lesson_id = lessons.id
      LEFT JOIN payment_allocations
        ON payment_allocations.lesson_charge_id = lesson_charges.id
      WHERE lessons.google_event_id IS NOT NULL
        AND lessons.google_event_id != ''
        AND datetime(lessons.start_time) >= datetime(?)
        AND datetime(lessons.start_time) <= datetime(?)
      GROUP BY lessons.id
    `
  );
  const deleteLesson = db.prepare("DELETE FROM lessons WHERE id = ?");
  const markLessonGoogleDeleted = db.prepare(
    `
      UPDATE lessons
      SET google_status = 'deleted',
          google_deleted_at = COALESCE(google_deleted_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
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
    deletedUntouchedLessons: 0,
    preservedDeletedCalendarLessons: 0,
    createdPayments: 0,
    dryRun,
    wouldInsertLessons: 0,
    wouldUpdateLessons: 0,
    wouldCreatePayments: 0,
    ignoredEvents: [],
    matchedEventDetails: [],
  };

  const events = options.events ?? (await listUpcomingEvents(calendar!, syncWindow));
  const activeGoogleEventIds = new Set(
    events
      .filter(eventIsActive)
      .map((event) => event.id)
      .filter((eventId): eventId is string => Boolean(eventId))
  );
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
    let action: MatchedEventDetail["action"];
    let paymentCreated = false;

    if (existingLesson) {
      lessonId = existingLesson.id;

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
        if (!dryRun) {
          result.updatedLessons += 1;
        }
      }
    } else {
      const status = "scheduled";

      result.wouldInsertLessons += 1;
      if (dryRun) {
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
          paymentCreated: false,
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

      const localSyncedLessons = findLocalSyncedLessonsInWindow.all(
        syncWindow.timeMin,
        syncWindow.timeMax
      ) as LocalSyncedLesson[];

      for (const lesson of localSyncedLessons) {
        if (activeGoogleEventIds.has(lesson.google_event_id)) {
          continue;
        }

        if (lessonIsUntouched(lesson)) {
          deleteLesson.run(lesson.id);
          result.deletedUntouchedLessons += 1;
          console.log("calendar event deleted; untouched local lesson removed", {
            lessonId: lesson.id,
            googleEventId: lesson.google_event_id,
          });
          continue;
        }

        markLessonGoogleDeleted.run(lesson.id);
        result.preservedDeletedCalendarLessons += 1;
        console.log(
          "calendar event deleted; local lesson preserved because it has local state",
          {
            lessonId: lesson.id,
            googleEventId: lesson.google_event_id,
            status: lesson.status,
          }
        );
      }
    });

    syncEvents(events);
  }

  saveCalendarSyncStatus("success", result);
  console.log("calendar sync finished", {
    scannedEvents: result.scannedEvents,
    matchedEvents: result.matchedEvents,
    insertedLessons: result.insertedLessons,
    updatedLessons: result.updatedLessons,
    skippedProtectedLessons: result.skippedProtectedLessons,
    deletedUntouchedLessons: result.deletedUntouchedLessons,
    preservedDeletedCalendarLessons: result.preservedDeletedCalendarLessons,
  });

  return result;
  } catch (error) {
    saveCalendarSyncStatus("failed", null, error);
    console.error("calendar sync failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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
    if (isInvalidGrantError(error)) {
      console.error(invalidGoogleTokenMessage);
      process.exit(1);
    }

    console.error("Calendar sync failed:");
    if (error && typeof error === "object") {
      const safeError = error as {
        name?: unknown;
        message?: unknown;
        code?: unknown;
        status?: unknown;
      };

      console.error({
        name: safeError.name,
        message: safeError.message,
        code: safeError.code,
        status: safeError.status,
      });
    } else {
      console.error({
        name: undefined,
        message: String(error),
        code: undefined,
        status: undefined,
      });
    }
    process.exit(1);
  }
}

const currentFilePath = fileURLToPath(import.meta.url);
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (currentFilePath === executedFilePath) {
  void main();
}
