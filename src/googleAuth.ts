import fs from "fs";
import path from "path";
import readline from "readline";
import { google } from "googleapis";

const credentialsPath = path.join(process.cwd(), "config", "google-credentials.json");
const tokenPath = path.join(process.cwd(), "config", "google-token.json");

const scopes = [
  "https://www.googleapis.com/auth/calendar.readonly",
];

function askQuestion(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const credentialsRaw = fs.readFileSync(credentialsPath, "utf-8");
  const credentials = JSON.parse(credentialsRaw);

  const clientInfo = credentials.installed;
  const oauth2Client = new google.auth.OAuth2(
    clientInfo.client_id,
    clientInfo.client_secret,
    clientInfo.redirect_uris[0]
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
  });

  console.log("\nOpen this URL in your browser:\n");
  console.log(authUrl);

  const redirectUrl = await askQuestion("\nPaste the full redirect URL here: ");

const url = new URL(redirectUrl);
const code = url.searchParams.get("code");

if (!code) {
  throw new Error("No code found in URL");
}

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));

  console.log("\nGoogle token saved successfully:");
  console.log(tokenPath);
}

main().catch((error) => {
  console.error("Google auth failed:");
  console.error(error);
  process.exit(1);
});