import { BotApplication } from "./lifecycle";

async function main(): Promise<void> {
  const app = new BotApplication();

  const shutdown = async () => {
    await app.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await app.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
