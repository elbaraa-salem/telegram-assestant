import "dotenv/config";
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH ?? "";
const phoneNumber = process.env.TG_PHONE ?? "";
const sessionString = process.env.TG_SESSION ?? "";

if (!apiId || !apiHash || !phoneNumber) {
  throw new Error("Missing TG_API_ID, TG_API_HASH, or TG_PHONE in .env");
}

export async function getTelegramClient(
  serviceName = "unknownService",
  options: { sendOnly?: boolean } = {}
): Promise<TelegramClient> {
  const sendOnly = options.sendOnly === true;
  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
      autoReconnect: !sendOnly,
      reconnectRetries: sendOnly ? 0 : undefined,
    }
  );

  await client.start({
    phoneNumber: async () => phoneNumber,
    password: async () => await input.text("Telegram 2FA password: "),
    phoneCode: async () => await input.text("Telegram code: "),
    onError: (error) => {
      if (sendOnly && error.message.includes("TIMEOUT")) {
        return;
      }

      console.error(error);
    },
  });

  console.log(`${serviceName} Telegram client connected`, {
    pid: process.pid,
  });

  if (!sessionString) {
    console.log("\nSave this session in .env as TG_SESSION:\n");
    console.log(client.session.save());
    console.log();
  }

  return client;
}
