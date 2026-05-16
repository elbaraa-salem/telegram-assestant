import "dotenv/config";
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

// Manual test script only. Do not import this from production services.

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const phoneNumber = process.env.TG_PHONE ?? "";
const sessionString = process.env.TG_SESSION ?? "";

if (!apiId || !apiHash || !phoneNumber) {
  throw new Error("Missing TG_API_ID, TG_API_HASH, or TG_PHONE in .env");
}

const stringSession = new StringSession(sessionString);

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

function toUnixTimestampInSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

async function main() {
  await client.start({
    phoneNumber: async () => phoneNumber,
    password: async () => await input.text("Telegram 2FA password: "),
    phoneCode: async () => await input.text("Telegram code: "),
    onError: (err) => console.error(err),
  });

  console.log("sendTestMessage Telegram client connected", {
    pid: process.pid,
  });
  console.log("Logged in successfully.");

  if (!sessionString) {
  const savedSession = client.session.save();

  console.log("\nSave this session in .env as TG_SESSION:\n");
  console.log(savedSession);
  console.log();
  }

  const target = "@baraa38";
  const message = "أنا البوت، تسلم يمعلم";

  // مثال: 15 مايو 2026 الساعة 20:30 بتوقيت جهازك
  const sendAt = new Date("2026-05-15T20:30:00+02:00");

//   await client.sendMessage(target, {
//     message,
//     schedule: toUnixTimestampInSeconds(sendAt),
//   });
await client.sendMessage(target, {
  message,
});

  console.log("Message scheduled successfully.");

  await client.disconnect();
  console.log("sendTestMessage Telegram client disconnected", {
    pid: process.pid,
  });
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
