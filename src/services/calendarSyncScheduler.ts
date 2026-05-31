import "dotenv/config";
import { syncCalendarLessons } from "./calendarSync";

const intervalMinutes = Number(
  process.env.CALENDAR_SYNC_INTERVAL_MINUTES ?? 10
);
const intervalMs =
  Number.isFinite(intervalMinutes) && intervalMinutes > 0
    ? intervalMinutes * 60 * 1000
    : 10 * 60 * 1000;

let syncRunning = false;

async function runScheduledSync(): Promise<void> {
  if (syncRunning) {
    console.log("calendar sync skipped because previous run is still active");
    return;
  }

  syncRunning = true;

  try {
    await syncCalendarLessons();
  } catch (error) {
    console.error("calendar sync failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    syncRunning = false;
  }
}

console.log("production scheduler started", {
  calendarSyncIntervalMinutes: intervalMs / 60_000,
});

void runScheduledSync();
setInterval(() => {
  void runScheduledSync();
}, intervalMs);
