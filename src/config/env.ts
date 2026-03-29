import dotenv from "dotenv";
import { AppConfig } from "../domain/types";
import { validateAndBuildConfig } from "./validation";

export function loadConfig(): AppConfig {
  dotenv.config();
  return validateAndBuildConfig(process.env);
}
