import { customAlphabet } from "nanoid";

const generator = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 26);

export function createId(prefix: string): string {
  return `${prefix}_${generator()}`;
}
