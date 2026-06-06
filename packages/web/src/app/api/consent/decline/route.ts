import { prisma } from '@wabi/shared';
import { validateRequest } from '@/lib/session';
import { lucia } from '@/lib/auth';
import { NextResponse } from 'next/server';

export async function POST(): Promise<Response> {
  const { user, session } = await validateRequest();
  if (!user || !session) {
    return new Response('Unauthorized', { status: 401 });
  }

  await lucia.invalidateSession(session.id);
  await prisma.user.delete({ where: { id: user.id } });

  const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/`);
  response.cookies.set(lucia.sessionCookieName, '', { maxAge: -1, path: '/' });
  return response;
}
