import pino from "pino";
import { AppConfig } from "../domain/types";

export function createLogger(config: AppConfig): pino.Logger {
  return pino({
    level: config.logLevel,
    base: undefined,
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}
