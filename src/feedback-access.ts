import type { User } from 'firebase/auth';

export const FEEDBACK_ADMIN_EMAIL = '[redacted]';

export function isFeedbackAdmin(user: User | null | undefined): boolean {
  return Boolean(
    user &&
      user.emailVerified &&
      user.email?.trim().toLowerCase() === FEEDBACK_ADMIN_EMAIL,
  );
}
