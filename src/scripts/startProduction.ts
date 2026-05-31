import { spawn } from "node:child_process";

const commands = [
  ["npm", ["run", "start:web"]],
  ["npm", ["run", "listen:telegram"]],
  ["npm", ["run", "sync:calendar:scheduler"]],
] as const;

const env = {
  ...process.env,
  APP_MODE: process.env.APP_MODE || "production",
  ENABLE_TEST_SEED: "false",
};

console.log("production startup", {
  appMode: env.APP_MODE,
  testSeedEnabled: env.ENABLE_TEST_SEED,
});

for (const [command, args] of commands) {
  const child = spawn(command, args, {
    env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    console.error("production child process exited", {
      command: [command, ...args].join(" "),
      code,
      signal,
    });

    if (code && code !== 0) {
      process.exitCode = code;
    }
  });
}
