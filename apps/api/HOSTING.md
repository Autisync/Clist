# Hosting `apps/api`

This app needs a real, persistent server process — not Vercel's serverless
functions — because of two things nothing here can route around:
Playwright (REF PDF generation, `src/routes/ref.ts`) needs a real headless-
Chromium process, and Fastify itself assumes one long-lived process, not a
stateless request-scoped function.

Everything below was actually built and run, not assumed: a real
`docker build` of [`Dockerfile`](Dockerfile), run locally, walked through a
complete real HTTP flow from *outside* the container — office login → jobs
list → REF document creation → Playwright PDF generation (confirmed on
disk: a real 31KB `%PDF-1.4` file) — against the real Supabase project.
Two real, non-obvious problems turned up doing that, both fixed here, not
worked around:

## 1. The direct Supabase connection is IPv6-only

`src/db.ts`'s original real-Postgres connection (`db.<project-ref>.supabase.co`)
resolves to an IPv6 address only — this is Supabase's own documented
behavior, not a misconfiguration. It works fine from an environment with
real IPv6 egress (this repo's own dev sandbox is one), but fails outright
(`ENOTFOUND` / "Network is unreachable") from one that isn't — confirmed by
building this exact Docker image and running it locally, where Docker
Desktop's default networking has no real IPv6 route. Real hosting
platforms vary the same way: Render has no outbound IPv6 support at all as
of this writing; even Fly.io, which generally does support IPv6 egress,
has had real regional outages reported specifically against Supabase's
IPv6 endpoint.

**Fix**: `src/db.ts` now supports an optional `SUPABASE_DB_POOLER_HOST` —
when set, it connects through Supabase's own Supavisor connection pooler
instead of the direct host, which is IPv4-reachable. This is Supabase's own
documented recommendation for exactly this situation, not a workaround
invented here. Confirmed empirically to behave identically to the direct
connection for everything this codebase depends on (the `search_path`
startup option, `SET LOCAL role` actually taking effect for the rest of a
transaction and reverting after commit) — proven by re-running every
`proof:phase1-4` script, `smoke:web`, and the Supabase verify suite with it
set, all passing with identical counts to the direct connection.

**Getting the value**: Supabase dashboard → Project Settings → Database →
Connect → the "Transaction pooler" or "Session pooler" tab shows a host
like `aws-<0 or 1>-<region>.pooler.supabase.com`. The generation prefix
(`aws-0-` vs `aws-1-`) and region are assigned per-project and genuinely
can't be derived from `SUPABASE_PROJECT_REF` alone (confirmed by trying —
every AWS region under the older `aws-0-` prefix failed with "tenant/user
not found" for this project's real ref before the newer `aws-1-` prefix
was tried) — the dashboard is the only reliable source. Use the *host*
only; `db.ts` builds the rest of the connection (`postgres.<project-ref>`
user, session-mode port 5432) itself.

## 2. The server binds to `127.0.0.1` by default

Correct for local dev and every proof/smoke script (all same-machine
callers) — but unreachable through a container's published port. Confirmed
by literally hitting exactly this: the containerized server passed its own
internal `/health` check while being completely unreachable from the host
machine, until this was fixed. `src/index.ts` now reads an optional `HOST`
env var (defaulting to `127.0.0.1`, unchanged for local dev); the
[`Dockerfile`](Dockerfile) sets `HOST=0.0.0.0`.

## 3. The object store is local disk — a known, honest limitation

`src/object-store.ts`'s own comment already says this plainly: photos and
generated REF PDFs are written to `FIELDREADY_RUNTIME_DIR/objects` on local
disk, an explicit stand-in for real object storage (S3/R2) that hasn't been
built yet. Hosting this for real means either:

- **Accept the limitation for now** (what [`render.yaml`](../render.yaml)
  does): mount a persistent disk at `FIELDREADY_RUNTIME_DIR` so files
  survive restarts/redeploys — but this only works for a single instance;
  horizontal scaling would need every instance to see the same files, which
  a per-instance disk doesn't give you.
- **Swap `object-store.ts` for a real S3/R2-backed implementation** —
  architecture §2's own original plan, genuinely future work, not attempted
  here. Nothing that calls `ObjectStore` needs to change when that happens,
  same as the PGlite→real-Postgres swap changed nothing above `db.ts`.

For FieldReady's current scale (real usage hasn't started), the first
option is a reasonable, honestly-caveated starting point — not silently
glossed over.

## Recommendation: Render

**[`render.yaml`](../render.yaml)** is a ready-to-use Render Blueprint —
Docker web service, the persistent disk from §3 above, and every env var
this app needs, with real secrets left for you to fill in (Render prompts
for them, never commits them). To use it:

1. Render dashboard → New → Blueprint → point at this repo. Render reads
   `render.yaml` and proposes the service.
2. Fill in the env vars Render prompts for: `SUPABASE_PROJECT_REF`,
   `SUPABASE_DB_PASSWORD`, `SUPABASE_DB_POOLER_HOST` (§1 above),
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` — the same five values
   already in your local `apps/api/.env`. `SESSION_JWT_SECRET` is
   generated by Render itself (`generateValue: true`), not something you
   supply.
3. Deploy. Render builds `apps/api/Dockerfile` and runs it — the same image
   this doc's own testing already proved works end to end.
4. Once it's up, point `apps/web`'s `FIELDREADY_API_ORIGIN` (Vercel env var,
   see [`../apps/web/VERCEL.md`](../apps/web/VERCEL.md)) at Render's
   assigned URL.

Why Render over the alternatives: simplest connect-and-deploy flow of the
container-friendly options (no CLI/config tool required beyond this one
committed file), a real Docker web service with persistent disks and
predictable flat pricing, and — now that §1's fix is in — its lack of
outbound IPv6 support is no longer a blocker, which was otherwise its one
real weakness for this specific app.

**Alternative: Fly.io.** More control (global distribution, `flyctl`-driven
deploys, pay-per-second billing), and its own native IPv6 egress means it
could in principle skip §1's pooler fix entirely for the direct Supabase
connection — except real regional IPv6 outages against Supabase have been
reported even there, so the pooler fix is worth keeping regardless of
which host you pick; it doesn't cost anything to leave it in place. Needs a
hand-written `fly.toml` (not included here) and `flyctl launch` /
`flyctl deploy` instead of this repo's one-file Blueprint — reach for this
if Render's regions or pricing shape don't fit, not as a default.

## Self-hosting: Portainer on your own VPS

Not a managed platform like Render/Fly.io — Portainer is a web UI for
managing Docker containers on a server you already provision and maintain
yourself (OS updates, security patches, a reverse proxy for TLS/your own
domain — none of that is Portainer's job, unlike Render/Fly.io which
handle it for you). If you already have a VPS with Portainer running,
**[`portainer-stack.yml`](../portainer-stack.yml)** at the repo root is the
same deployment as `render.yaml`, in Docker Compose form — same
`Dockerfile`, same required env vars, same persistent-volume caveat for
the object store (§3 above). Built and run locally with real `docker
compose` before writing this doc line, not assumed: it built, started,
reported `(healthy)` on Docker's own healthcheck, and answered `/health`
from outside the container exactly like the plain `docker run` test
earlier in this doc did.

To deploy it:

1. Portainer → **Stacks** → **Add stack** → **Repository**, point at this
   repo/branch, Compose path: `portainer-stack.yml`. (A pasted-in "Web
   editor" stack only works if Portainer is building on a machine that
   already has this repo checked out where it runs `docker build` from —
   prefer the Git-repository method.)
2. In the stack's **Environment variables** section, fill in the same five
   Supabase values Render's Blueprint prompts for (see the table below),
   plus a real random `SESSION_JWT_SECRET` (Render's Blueprint generates
   one for you; here you generate it yourself — `openssl rand -hex 32` —
   and paste it in, since Portainer has no equivalent auto-generate
   button), plus `HOST_DOMAIN` (see below).
3. Deploy the stack.

**TLS/routing** — `portainer-stack.yml`'s Traefik labels assume a Traefik
instance is already running on the host with a Docker provider watching an
external network named `proxy`; if yours does too (check by comparing
against an existing working container's own labels — `docker inspect
<container> --format '{{json .Config.Labels}}'`, confirmed empirically
against a real host this way, not guessed), it just works once `HOST_DOMAIN`
is set. No Traefik yet, or a different reverse proxy? The file's own header
comment says exactly what to delete/uncomment to fall back to the plain
`ports: ["3001:3001"]` setup this whole doc's testing already proved works,
just without a real domain or TLS in front of it.

No domain yet either? A free [sslip.io](https://sslip.io) hostname (e.g.
`<your-server-ip-with-dashes-for-dots>.sslip.io`) resolves to your
server's real IP with zero registration — Let's Encrypt can issue a real
cert for it exactly like it would for a paid domain, since it's a real,
publicly resolvable hostname (which a bare IP address structurally can't
be). Confirmed resolving correctly before relying on it.

4. Point `apps/web`'s `FIELDREADY_API_ORIGIN` at `https://` + your
   `HOST_DOMAIN`.

## Required environment variables

| Variable | Notes |
|---|---|
| `SUPABASE_PROJECT_REF` | Same value already in `apps/api/.env`. |
| `SUPABASE_DB_PASSWORD` | Same value already in `apps/api/.env`. Superuser Postgres credential — server-only, forever. |
| `SUPABASE_DB_POOLER_HOST` | §1 above — get this one from the Supabase dashboard, not derivable from the project ref. |
| `SUPABASE_SERVICE_ROLE_KEY` | Same value already in `apps/api/.env`. Bypasses RLS entirely — server-only, forever. |
| `SUPABASE_ANON_KEY` | Same value already in `apps/api/.env` / `apps/web/.env.local`'s `NEXT_PUBLIC_SUPABASE_ANON_KEY`. |
| `SESSION_JWT_SECRET` | A real random value — `render.yaml` has Render generate one; don't reuse the fixed strings the proof scripts use. |
| `HOST` | `0.0.0.0` for any container host (§2 above). Leave unset locally. |
| `FIELDREADY_RUNTIME_DIR` | Point this at your persistent disk's mount path (§3 above). |
| `HOST_DOMAIN` | Portainer/Traefik setup only — the real hostname Traefik routes to this service (e.g. a sslip.io hostname, or a real domain). Not used by Render, which handles its own domain/TLS. |
| `VERYFI_CLIENT_ID` / `VERYFI_CLIENT_SECRET` / `VERYFI_USERNAME` / `VERYFI_API_KEY` | Optional — all four unset keeps using the deterministic fixture OCR provider. |

`FASTIFY_DB_SCHEMA` is optional and best left unset in production (defaults
to `fastify_api`) — only override it to run a second, fully separate copy
of this classic system's tables against the same Supabase project.
