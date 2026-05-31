import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { google } from "googleapis";

const credentialsPath = path.join(
  process.cwd(),
  "config",
  "google-credentials.json"
);
const tokenPath = path.join(process.cwd(), "config", "google-token.json");
const scopes = ["https://www.googleapis.com/auth/calendar.readonly"];

type GoogleOAuthCredentials = {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
};

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

function getClientInfo(credentials: GoogleOAuthCredentials) {
  const clientInfo = credentials.installed ?? credentials.web;

  if (!clientInfo) {
    throw new Error("Missing installed or web OAuth client in Google credentials");
  }

  if (!clientInfo.redirect_uris.length) {
    throw new Error("Missing redirect URI in Google credentials");
  }

  return clientInfo;
}

function parseAuthorizationCode(input: string): string {
  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    return input;
  }

  const code = new URL(input).searchParams.get("code");

  if (!code) {
    throw new Error("No authorization code found in pasted URL");
  }

  return code;
}

async function main() {
  const credentials = JSON.parse(
    fs.readFileSync(credentialsPath, "utf8")
  ) as GoogleOAuthCredentials;
  const clientInfo = getClientInfo(credentials);

  const oauth2Client = new google.auth.OAuth2(
    clientInfo.client_id,
    clientInfo.client_secret,
    clientInfo.redirect_uris[0]
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });

  console.log("\nOpen this URL in your browser:\n");
  console.log(authUrl);

  const codeInput = await askQuestion("\nPaste the authorization code here: ");
  const code = parseAuthorizationCode(codeInput);
  const { tokens } = await oauth2Client.getToken(code);

  fs.writeFileSync(tokenPath, `${JSON.stringify(tokens, null, 2)}\n`);

  console.log("\nGoogle token saved successfully:");
  console.log(tokenPath);
}

main().catch((error) => {
  console.error("Google auth failed:");
  if (error && typeof error === "object") {
    const safeError = error as { name?: unknown; message?: unknown };
    console.error({
      name: safeError.name,
      message: safeError.message,
    });
  } else {
    console.error({ message: String(error) });
  }
  process.exit(1);
});
