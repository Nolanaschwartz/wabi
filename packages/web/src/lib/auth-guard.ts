import type { User } from 'lucia';
import { validateRequest } from '@/lib/session';

export async function requireAuthenticated(): Promise<User | Response> {
  const { user } = await validateRequest();
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }
  return user;
}
