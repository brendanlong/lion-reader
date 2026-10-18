/**
 * The password length rule, shared by the server's input schemas
 * (`passwordSchema` in `src/server/auth/password.ts`) and the forms that check it
 * before submitting.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function passwordTooShortMessage(label: string): string {
  return `${label} must be at least ${PASSWORD_MIN_LENGTH} characters`;
}

export function passwordTooLongMessage(label: string): string {
  return `${label} must be less than ${PASSWORD_MAX_LENGTH} characters`;
}

/** What's wrong with a new password's length, or null if nothing. */
export function passwordLengthError(password: string, label = "Password"): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return passwordTooShortMessage(label);
  if (password.length > PASSWORD_MAX_LENGTH) return passwordTooLongMessage(label);
  return null;
}
