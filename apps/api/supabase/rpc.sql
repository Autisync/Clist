-- ============================================================================
-- FieldReady — Supabase-native RPC functions.
-- 08-supabase-native-migration.md §6 Step 3 / §4.
--
-- Applied on top of schema.sql (§6 Step 1) — not merged into it, so the pure
-- table/RLS layer and the RPC-function layer can each be reasoned about (and
-- reapplied) independently. §4 names three candidates for this treatment;
-- this file starts with exactly one, per Step 3's own scope ("one write
-- path... proven before extending to the rest of the surface") —
-- dispatch_job() and create_job_from_quote() are deliberately not here yet.
--
-- Every function below is SECURITY INVOKER (the default — no `security
-- definer` clause), unlike fn_current_tenant_id() in schema.sql. That's
-- deliberate: these functions exist to preserve the ATOMICITY and
-- IDEMPOTENCY of a multi-statement apply-then-record sequence that would
-- otherwise be lost across several separate client calls (§1's second
-- problem) — they are not meant to grant any privilege the caller didn't
-- already have. Running as SECURITY INVOKER means every statement inside
-- still evaluates RLS as the calling session, exactly as if the caller had
-- run it directly — RLS stays the sole access boundary, per the whole
-- migration's premise, with the RPC adding only atomicity on top.
-- ============================================================================

-- rpc_checklist_item_update: the exact apply logic
-- apps/api/src/routes/sync.ts's applyMutation() implements for
-- "checklist_item.update" today, ported literally (read that file's case
-- branch before touching this — the sequence must transfer as-is, not be
-- reinvented, per §4). Differences from the Fastify version, both a direct
-- consequence of RLS now being the sole boundary rather than an app-layer
-- check:
--   1. No explicit `and tenant_id = $N` in the UPDATE's WHERE clause — RLS
--      (job_checklist_item's tenant_isolation policy, schema.sql §12)
--      already restricts which rows are visible/updatable to the caller's
--      own tenant. Adding a redundant explicit check here would be
--      duplicating, not backing up, what RLS already guarantees.
--   2. tenant_id for the applied_mutation bookkeeping row comes from
--      fn_current_tenant_id() directly, not from a trusted request context
--      built by an authenticating server — there is no such server in this
--      path anymore.
-- occurred_at (part of the wire envelope, packages/core/src/sync.ts) is
-- deliberately NOT a parameter here: the reference implementation never
-- reads it either ("device clock, ordering only — never trusted for
-- business logic") — this function ports the actual apply logic, not the
-- full mutation envelope shape.
create or replace function rpc_checklist_item_update(
  p_client_mutation_id uuid,
  p_job_id uuid,
  p_item_id uuid,
  p_status text
)
returns jsonb
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_existing  jsonb;
  v_updated_id uuid;
  v_result    jsonb;
begin
  v_tenant_id := fn_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'rpc_checklist_item_update: no tenant context resolved for this session';
  end if;

  if p_status not in ('ok', 'missing') then
    raise exception 'rpc_checklist_item_update: invalid status %', p_status;
  end if;

  -- Idempotency lookup — identical sequence to sync.ts's applyMutation:
  -- look up by client_mutation_id first (RLS on applied_mutation already
  -- scopes this to the caller's own tenant); if found, return the
  -- previously-recorded result instead of re-applying anything.
  select result into v_existing
  from applied_mutation
  where client_mutation_id = p_client_mutation_id;

  if v_existing is not null then
    return v_existing || jsonb_build_object('status', 'already_applied');
  end if;

  update job_checklist_item
  set status = p_status
  where id = p_item_id and job_id = p_job_id
  returning id into v_updated_id;

  if v_updated_id is not null then
    v_result := jsonb_build_object('client_mutation_id', p_client_mutation_id, 'status', 'applied');
  else
    -- RLS makes "doesn't exist" and "belongs to a different tenant"
    -- indistinguishable from the caller's side (the row is simply not
    -- visible), which is the right property — the same reason the read
    -- path never leaks a different tenant's row count either.
    v_result := jsonb_build_object(
      'client_mutation_id', p_client_mutation_id, 'status', 'rejected', 'reason', 'item_not_found'
    );
  end if;

  insert into applied_mutation (client_mutation_id, tenant_id, mutation_type, result)
  values (p_client_mutation_id, v_tenant_id, 'checklist_item.update', v_result);

  return v_result;
end;
$$;

comment on function rpc_checklist_item_update(uuid, uuid, uuid, text) is
  'Step 3''s chosen write path (08-supabase-native-migration.md §6). SECURITY '
  'INVOKER, not DEFINER — RLS on job_checklist_item/applied_mutation is what '
  'actually restricts this, the function only adds atomicity+idempotency '
  'across what would otherwise be several separate client calls.';

revoke execute on function rpc_checklist_item_update(uuid, uuid, uuid, text) from public;
grant execute on function rpc_checklist_item_update(uuid, uuid, uuid, text) to authenticated;

-- ============================================================================
-- End of Step 3's RPC surface. Deliberately not here yet (§4/§6 step 4):
-- the other four sync mutation types (execution_step.complete,
-- test_result.record, closeout.submit, van_audit.record), dispatch_job(),
-- and create_job_from_quote(). Each gets the same treatment — read the
-- existing domain function it must stay byte-identical to, port literally,
-- prove with its own check — one slice at a time, not all at once.
-- ============================================================================
