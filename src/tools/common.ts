import { z } from "zod";
import { getAccount } from "../auth.js";

export const accountEmailSchema = z
  .string()
  .email()
  .optional()
  .describe(
    "Google account email. May be omitted when exactly one account is configured; required when multiple accounts are configured.",
  );

export function accountFor(email?: string) {
  return getAccount(email);
}
