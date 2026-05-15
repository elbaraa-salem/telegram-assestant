import fs from "fs";
import path from "path";
import { google } from "googleapis";

const credentialsPath = path.join(
  process.cwd(),
  "config",
  "google-credentials.json"
);

const tokenPath = path.join(
  process.cwd(),
  "config",
  "google-token.json"
);

async function main() {
  const credentials = JSON.parse(
    fs.readFileSync(credentialsPath, "utf8")
  );

  const tokens = JSON.parse(
    fs.readFileSync(tokenPath, "utf8")
  );

  const clientInfo = credentials.installed;

  const oauth2Client = new google.auth.OAuth2(
    clientInfo.client_id,
    clientInfo.client_secret,
    clientInfo.redirect_uris[0]
  );

  oauth2Client.setCredentials(tokens);

  const calendar = google.calendar({
    version: "v3",
    auth: oauth2Client,
  });

  const response = await calendar.events.list({
    calendarId: "primary",
    maxResults: 10,
    singleEvents: true,
    orderBy: "startTime",
    timeMin: new Date().toISOString(),
  });

  const events = response.data.items ?? [];

  console.log("\nUpcoming events:\n");

  for (const event of events) {
    console.log({
      id: event.id,
      title: event.summary,
      start: event.start?.dateTime || event.start?.date,
    });
  }
}

main().catch(console.error);