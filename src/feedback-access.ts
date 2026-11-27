import type { User } from 'firebase/auth';

export async function isFeedbackAdmin(user: User | null | undefined): Promise<boolean> {
  if (!user?.emailVerified) return false;
  try {
    const token = await user.getIdTokenResult();
    return token.claims.admin === true;
  } catch {
    return false;
  }
}
