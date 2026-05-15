import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import input from "input";
import { db } from "../database/db";

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH ?? "";
const phoneNumber = process.env.TG_PHONE ?? "";
const sessionString = process.env.TG_SESSION ?? "";
const session = new StringSession(sessionString);

if (!apiId || !apiHash || !phoneNumber) {
  throw new Error("Missing TG_API_ID, TG_API_HASH, or TG_PHONE in .env");
}

function cleanUsername(username: string): string {
  return username.trim().replace(/^@/, "");
}

async function main() {
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => phoneNumber,
    password: async () => await input.text("2FA password: "),
    phoneCode: async () => await input.text("Telegram code: "),
    onError: (err) => console.error(err),
  });

  console.log("\nTelegram login successful.");

  if (!sessionString) {
    console.log("\nSave this session string in .env as TG_SESSION:\n");
    console.log(client.session.save());
  }

  const students = db.prepare(`
    SELECT id, name_ar, telegram_username
    FROM students
    WHERE telegram_username IS NOT NULL
      AND telegram_username != ''
      AND (telegram_id IS NULL OR telegram_id = '')
  `).all() as Array<{
    id: number;
    name_ar: string;
    telegram_username: string;
  }>;

  for (const student of students) {
    try {
      const username = cleanUsername(student.telegram_username);

      const entity: any = await client.getEntity(username);

      const telegramId = entity.id?.toString();

      if (!telegramId) {
        console.log(`No ID found for ${student.name_ar} @${username}`);
        continue;
      }

      db.prepare(`
        UPDATE students
        SET telegram_id = ?
        WHERE id = ?
      `).run(telegramId, student.id);

      console.log(`Updated ${student.name_ar}: @${username}`);
    } catch (error) {
      console.log(`Failed for ${student.name_ar} (${student.telegram_username})`);
      console.log(error);
    }
  }

  await client.disconnect();
}

main().catch(console.error);
