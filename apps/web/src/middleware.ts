import { NextRequest, NextResponse } from "next/server";

/*
 * UX-only redirect based on presence of the fr_session cookie. This is NOT
 * the real security boundary — the API enforces auth (and tenant
 * isolation) for real on every request; this middleware only spares a
 * logged-out user from staring at a broken page before the API 401s.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has("fr_session");

  if (pathname.startsWith("/office") && !hasSession) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname.startsWith("/field") && pathname !== "/field/login" && !hasSession) {
    const loginUrl = new URL("/field/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/office/:path*", "/field/:path*"],
};
