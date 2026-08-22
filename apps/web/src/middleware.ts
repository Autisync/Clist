import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/*
 * §6 Step 5 (08-supabase-native-migration.md): /office/* now accepts EITHER
 * a real Supabase Auth session OR the original fr_session cookie — not
 * Supabase exclusively. This migration is mid-flight: only the jobs list
 * (so far) reads from Supabase; every other /office/* page (job detail,
 * clients, quotes, suppliers, technicians, dashboard) is still entirely
 * Fastify-backed and depends on fr_session for its own data fetch. A first
 * version of this file required a Supabase session for the whole /office/*
 * tree — that broke every one of those still-Fastify-backed pages for
 * anyone who'd only ever authenticated the old way (caught by smoke.mjs:
 * "job detail page renders real data" started failing because middleware
 * was silently bouncing it to /login before the page ever rendered).
 * Accepting either session lets each page's own data layer be the thing
 * that decides whether it has what it needs, which is the honest state
 * during an incremental cutover — see apps/web/README.md for exactly
 * which pages are on which backend right now.
 *
 * supabase.auth.getUser() (not getSession()) validates the token against
 * Supabase Auth itself rather than trusting the cookie unverified, and
 * transparently refreshes it when needed (the official next/@supabase/ssr
 * middleware pattern). Still only a UX redirect, not the real security
 * boundary — RLS enforces access on every Supabase-backed request
 * regardless of what this middleware decides.
 *
 * /field/* is unchanged — still the original fr_session cookie check.
 * Technician/device auth migrates in its own later slice (§2 of the design
 * doc: "deliberately second, not parallel").
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/office")) {
    if (request.cookies.has("fr_session")) {
      return NextResponse.next();
    }

    let response = NextResponse.next({ request });

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            for (const { name, value } of cookiesToSet) {
              request.cookies.set(name, value);
            }
            response = NextResponse.next({ request });
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, options);
            }
          },
        },
      }
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }

    return response;
  }

  if (pathname.startsWith("/field") && pathname !== "/field/login") {
    const hasSession = request.cookies.has("fr_session");
    if (!hasSession) {
      const loginUrl = new URL("/field/login", request.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/office/:path*", "/field/:path*"],
};
