import { resolveMissingTelegramIds } from "../services/telegramIdentityService";

resolveMissingTelegramIds().catch((error) => {
  console.error("Telegram ID sync failed:");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
1