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
 * /field/*: technician-auth migration (08-supabase-native-migration.md §2)
 * — device pairing/login now issue a real Supabase session (routes/
 * technicians.ts, field/login/page.tsx), not fr_session at all, so this
 * branch needs the exact same either/or acceptance the /office/* branch
 * above already learned the hard way (same comment's own history: an
 * earlier version of THIS file required Supabase exclusively for /office/*
 * and broke every still-fr_session-only page). Any device paired before
 * this migration still signs in via the classic route and still gets
 * fr_session — checked first, unchanged, zero regression for it.
 */
async function hasRealSupabaseSession(request: NextRequest): Promise<{ ok: boolean; response: NextResponse }> {
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

  return { ok: user != null, response };
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/office")) {
    if (request.cookies.has("fr_session")) {
      return NextResponse.next();
    }

    const { ok, response } = await hasRealSupabaseSession(request);
    if (!ok) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
    return response;
  }

  if (pathname.startsWith("/field") && pathname !== "/field/login") {
    if (request.cookies.has("fr_session")) {
      return NextResponse.next();
    }

    const { ok, response } = await hasRealSupabaseSession(request);
    if (!ok) {
      const loginUrl = new URL("/field/login", request.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/office/:path*", "/field/:path*"],
};
