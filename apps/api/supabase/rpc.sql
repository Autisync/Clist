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
--
-- §6 Step 5 review finding (high, confirmed): the sync.ts applyMutation
-- branch this ports never sets updated_by/updated_at either — a real,
-- pre-existing gap between the phone's sync-mutation path and the office's
-- OWN direct PATCH /jobs/:id/checklist/:item_id route (which always has,
-- since Phase 2), that stayed invisible only because the office UI used to
-- call that direct route, not this shared one. Wiring apps/web's office
-- job-detail page to THIS function instead (§6 Step 5) is what first makes
-- the office lose attribution it always recorded before — not a
-- consequence of anything specific to Supabase, just this function finally
-- getting a caller that actually needs the column. Fixed here, which also
-- fixes the phone's own sync path for free — it never had this either.
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
  v_app_user_id uuid;
  v_existing  jsonb;
  v_updated_id uuid;
  v_result    jsonb;
begin
  v_tenant_id := fn_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'rpc_checklist_item_update: no tenant context resolved for this session';
  end if;
  v_app_user_id := fn_current_app_user_id();

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
  set status = p_status, updated_by = v_app_user_id, updated_at = now()
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
-- §6 Step 4: the remaining four sync mutation types, plus rpc_dispatch_job.
-- create_job_from_quote() is deliberately NOT here yet — genuinely more
-- complex (string slugification, template resolution across two coding
-- conventions, checklist materialization, quote-line merge with covered-item
-- tracking) and gets its own slice, not crammed in alongside these five.
-- Every function below follows Step 3's established shape: SECURITY INVOKER
-- (RLS does the actual restricting), the same applied_mutation lookup-then-
-- apply-then-insert sequence for the four real sync mutations, ported
-- literally from the domain function named in each comment — read that file
-- before touching the SQL below, the sequence must transfer as-is.
-- ============================================================================

-- fn_eval_test: SQL port of packages/core/src/test-protocol-eval.ts's
-- evalTest(), used by rpc_test_result_record below. p_test is one entry from
-- a job's frozen test_protocol_snapshot.tests array (jsonb) — same shape
-- TestProtocolTest describes, dir in ('range','min','max','external_pass_fail').
create or replace function fn_eval_test(p_test jsonb, p_value text)
returns text
language plpgsql
immutable
as $$
declare
  v_dir text := p_test->>'dir';
  v_min numeric;
  v_max numeric;
  v_num numeric;
  v_normalized text;
begin
  if p_value is null or p_value = '' then
    return 'pending';
  end if;

  if v_dir = 'external_pass_fail' then
    v_normalized := lower(trim(p_value));
    if v_normalized = 'pass' then return 'pass'; end if;
    if v_normalized = 'fail' then return 'fail'; end if;
    return 'pending';
  end if;

  begin
    v_num := p_value::numeric;
  exception when others then
    return 'pending';
  end;

  -- Security review (medium, confirmed): Postgres's numeric type accepts the
  -- literal 'NaN' (any case/whitespace) as a legitimate special value rather
  -- than raising — the exception handler above never fires for it — and
  -- compares it as greater than every other value, so without this check
  -- dir='min' would wrongly return 'pass' and dir='max'/'range' would wrongly
  -- return 'fail' for value='NaN', instead of evalTest()'s 'pending'
  -- (Number.isNaN(Number('NaN')) short-circuits before any comparison there).
  -- ::text always renders Postgres's NaN as exactly 'NaN' regardless of the
  -- input's original casing/whitespace — confirmed empirically against the
  -- real project before relying on it — and does NOT affect 'Infinity'/
  -- '-Infinity', which JS's Number() also treats as real, comparable values,
  -- not NaN, so those correctly still flow through to a real pass/fail below.
  if v_num::text = 'NaN' then
    return 'pending';
  end if;

  v_min := (p_test->>'min')::numeric;
  v_max := (p_test->>'max')::numeric;

  if v_dir = 'range' then
    return case when v_num >= v_min and v_num <= v_max then 'pass' else 'fail' end;
  elsif v_dir = 'min' then
    return case when v_num >= v_min then 'pass' else 'fail' end;
  else
    return case when v_num <= v_max then 'pass' else 'fail' end;
  end if;
end;
$$;

revoke execute on function fn_eval_test(jsonb, text) from public;
grant execute on function fn_eval_test(jsonb, text) to authenticated;

-- rpc_test_result_record: port of apps/api/src/domain/test-results.ts's
-- recordTestResult(). outcome is computed from the job's frozen
-- test_protocol_snapshot (never re-reads template/template_version, same
-- "resolved once" rule the TS version follows) — no match in the snapshot
-- means outcome='na', matching the TS branch exactly.
create or replace function rpc_test_result_record(
  p_client_mutation_id uuid,
  p_job_id uuid,
  p_network_type text,
  p_location_label text,
  p_test_code text,
  p_measured_value text,
  p_unit text,
  p_limit_ref text,
  p_capture_source text,
  p_raw_capture_file text,
  p_instrument_id uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_app_user_id uuid;
  v_existing jsonb;
  v_snapshot jsonb;
  v_matching_test jsonb;
  v_outcome text;
  v_inserted_id uuid;
  v_result jsonb;
begin
  v_tenant_id := fn_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'rpc_test_result_record: no tenant context resolved for this session';
  end if;
  v_app_user_id := fn_current_app_user_id();

  select result into v_existing from applied_mutation where client_mutation_id = p_client_mutation_id;
  if v_existing is not null then
    return v_existing || jsonb_build_object('status', 'already_applied');
  end if;

  select test_protocol_snapshot into v_snapshot from job where id = p_job_id;
  if not found then
    v_result := jsonb_build_object('client_mutation_id', p_client_mutation_id, 'status', 'rejected', 'reason', 'job_not_found');
    insert into applied_mutation (client_mutation_id, tenant_id, mutation_type, result)
    values (p_client_mutation_id, v_tenant_id, 'test_result.record', v_result);
    return v_result;
  end if;

  select t into v_matching_test
  from jsonb_array_elements(coalesce(v_snapshot->'tests', '[]'::jsonb)) as t
  where t->>'id' = p_test_code
  limit 1;

  if v_matching_test is null then
    v_outcome := 'na';
  else
    v_outcome := fn_eval_test(v_matching_test, p_measured_value);
  end if;

  insert into job_test_result
    (tenant_id, job_id, network_type, location_label, test_code, measured_value,
     unit, limit_ref, outcome, performed_at, performed_by, capture_source,
     raw_capture_file, instrument_id)
  values
    (v_tenant_id, p_job_id, p_network_type, p_location_label, p_test_code, p_measured_value,
     p_unit, p_limit_ref, v_outcome, now(), v_app_user_id, p_capture_source,
     p_raw_capture_file, p_instrument_id)
  returning id into v_inserted_id;

  v_result := jsonb_build_object(
    'client_mutation_id', p_client_mutation_id, 'status', 'applied',
    'id', v_inserted_id, 'outcome', v_outcome
  );

  insert into applied_mutation (client_mutation_id, tenant_id, mutation_type, result)
  values (p_client_mutation_id, v_tenant_id, 'test_result.record', v_result);

  return v_result;
end;
$$;

revoke execute on function rpc_test_result_record(uuid, uuid, text, text, text, text, text, text, text, text, uuid) from public;
grant execute on function rpc_test_result_record(uuid, uuid, text, text, text, text, text, text, text, text, uuid) to authenticated;

-- rpc_execution_step_complete: port of
-- apps/api/src/domain/execution-steps.ts's completeExecutionStep().
-- job_execution_step_completion's unique(job_id, step_order) is what makes
-- this idempotent for a genuinely repeated step-complete tap, same as the
-- TS version's ON CONFLICT — applied_mutation's own idempotency (below)
-- covers the separate case of a retried sync call for the *same*
-- client_mutation_id, which is a different guarantee than the table's own
-- upsert.
create or replace function rpc_execution_step_complete(
  p_client_mutation_id uuid,
  p_job_id uuid,
  p_step int
)
returns jsonb
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_app_user_id uuid;
  v_existing jsonb;
  v_job_exists boolean;
  v_row record;
  v_result jsonb;
begin
  v_tenant_id := fn_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'rpc_execution_step_complete: no tenant context resolved for this session';
  end if;
  v_app_user_id := fn_current_app_user_id();

  select result into v_existing from applied_mutation where client_mutation_id = p_client_mutation_id;
  if v_existing is not null then
    return v_existing || jsonb_build_object('status', 'already_applied');
  end if;

  select exists(select 1 from job where id = p_job_id) into v_job_exists;

  if not v_job_exists then
    v_result := jsonb_build_object('client_mutation_id', p_client_mutation_id, 'status', 'rejected', 'reason', 'job_not_found');
  else
    insert into job_execution_step_completion (tenant_id, job_id, step_order, completed_by)
    values (v_tenant_id, p_job_id, p_step, v_app_user_id)
    on conflict (job_id, step_order)
    do update set completed_at = now(), completed_by = excluded.completed_by
    returning step_order, completed_at, completed_by into v_row;

    v_result := jsonb_build_object(
      'client_mutation_id', p_client_mutation_id, 'status', 'applied',
      'step_order', v_row.step_order, 'completed_at', v_row.completed_at, 'completed_by', v_row.completed_by
    );
  end if;

  insert into applied_mutation (client_mutation_id, tenant_id, mutation_type, result)
  values (p_client_mutation_id, v_tenant_id, 'execution_step.complete', v_result);

  return v_result;
end;
$$;

revoke execute on function rpc_execution_step_complete(uuid, uuid, int) from public;
grant execute on function rpc_execution_step_complete(uuid, uuid, int) to authenticated;

-- rpc_van_audit_record: port of apps/api/src/domain/van-audit.ts's
-- recordVanAudit(). VAN_AUDIT_INTERVAL_DAYS = 7 there, same literal here —
-- forms-and-procedures-spec.md F04 "weekly, configurable"; per-tenant
-- configurable intervals remain a real future feature, not built here
-- either, matching the TS version's own scope exactly.
create or replace function rpc_van_audit_record(
  p_client_mutation_id uuid,
  p_van_label text,
  p_issues jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_app_user_id uuid;
  v_existing jsonb;
  v_row record;
  v_result jsonb;
begin
  v_tenant_id := fn_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'rpc_van_audit_record: no tenant context resolved for this session';
  end if;
  v_app_user_id := fn_current_app_user_id();

  select result into v_existing from applied_mutation where client_mutation_id = p_client_mutation_id;
  if v_existing is not null then
    return v_existing || jsonb_build_object('status', 'already_applied');
  end if;

  insert into van_audit (tenant_id, van_label, performed_by, performed_at, next_due_at, issues)
  values (v_tenant_id, p_van_label, v_app_user_id, now(), now() + interval '7 days', coalesce(p_issues, '[]'::jsonb))
  returning id, van_label, performed_at, next_due_at into v_row;

  v_result := jsonb_build_object(
    'client_mutation_id', p_client_mutation_id, 'status', 'applied',
    'id', v_row.id, 'van_label', v_row.van_label,
    'performed_at', v_row.performed_at, 'next_due_at', v_row.next_due_at
  );

  insert into applied_mutation (client_mutation_id, tenant_id, mutation_type, result)
  values (p_client_mutation_id, v_tenant_id, 'van_audit.record', v_result);

  return v_result;
end;
$$;

revoke execute on function rpc_van_audit_record(uuid, text, jsonb) from public;
grant execute on function rpc_van_audit_record(uuid, text, jsonb) to authenticated;

-- rpc_closeout_submit: port of apps/api/src/domain/closeout.ts's
-- submitCloseout(), the one piece of this migration's domain logic that
-- genuinely depends on holidays.sql (fn_add_working_days) — the termo
-- deadline it inserts must be holiday-aware, not calendar-day arithmetic.
-- rework_cause is not a parameter here at all, matching the TS version's
-- own comment: JobCloseoutTechnicianRequest has no such field, so there is
-- no way for this function to write it — office-side rework_cause
-- assignment stays a completely separate write path (not built as an RPC
-- in this pass either; still Fastify-only, matching where it already
-- lives). completed_at uses coalesce(completed_at, now()) for the exact
-- reason the TS comment gives: the phone flow (prep→site→tests→voice→done)
-- has no separate "mark complete" tap, so this is the only moment that path
-- ever reaches — found live-testing that exact gap, not a hypothetical, and
-- ported here unchanged rather than "fixed" into a different behavior.
create or replace function rpc_closeout_submit(
  p_client_mutation_id uuid,
  p_job_id uuid,
  p_first_time_fix boolean,
  p_technician_voice_note_file text,
  p_technician_note_transcript text,
  p_client_signature_file text
)
returns jsonb
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_app_user_id uuid;
  v_existing jsonb;
  v_completed_at_before timestamptz;
  v_closeout record;
  v_completed_at_after timestamptz;
  v_compliance_profile text;
  v_due_on date;
  v_result jsonb;
begin
  v_tenant_id := fn_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'rpc_closeout_submit: no tenant context resolved for this session';
  end if;
  v_app_user_id := fn_current_app_user_id();

  select result into v_existing from applied_mutation where client_mutation_id = p_client_mutation_id;
  if v_existing is not null then
    return v_existing || jsonb_build_object('status', 'already_applied');
  end if;

  -- Security review (high, confirmed): a plain, unlocked read here let two
  -- genuinely concurrent closeout submissions for the same job (different
  -- client_mutation_ids — the exact "resubmission before dispatch of a
  -- corrected voice note" scenario this function's own comment describes as
  -- intended usage, or a double-tap/retry race) both observe completed_at
  -- as null and each independently insert a termo compliance_deadline row,
  -- since compliance_deadline has no unique constraint on (job_id, kind) to
  -- catch the duplicate. FOR UPDATE closes this properly: the second
  -- transaction blocks here until the first commits, then re-reads the
  -- now-already-set completed_at, correctly skipping its own deadline
  -- insert below — not a workaround, the standard Postgres pattern for
  -- exactly this "read, decide, write" race.
  select completed_at into v_completed_at_before from job where id = p_job_id for update;
  if not found then
    v_result := jsonb_build_object('client_mutation_id', p_client_mutation_id, 'status', 'rejected', 'reason', 'job_not_found');
    insert into applied_mutation (client_mutation_id, tenant_id, mutation_type, result)
    values (p_client_mutation_id, v_tenant_id, 'closeout.submit', v_result);
    return v_result;
  end if;

  insert into job_closeout
    (tenant_id, job_id, first_time_fix, technician_voice_note_file,
     technician_note_transcript, client_signature_file, closed_by, closed_at)
  values
    (v_tenant_id, p_job_id, p_first_time_fix, p_technician_voice_note_file,
     p_technician_note_transcript, p_client_signature_file, v_app_user_id, now())
  on conflict (job_id) do update set
    first_time_fix = excluded.first_time_fix,
    technician_voice_note_file = excluded.technician_voice_note_file,
    technician_note_transcript = excluded.technician_note_transcript,
    client_signature_file = excluded.client_signature_file,
    closed_by = excluded.closed_by,
    closed_at = excluded.closed_at
  returning * into v_closeout;

  update job set status = 'closed', completed_at = coalesce(completed_at, now())
  where id = p_job_id
  returning completed_at into v_completed_at_after;

  if v_completed_at_before is null then
    select compliance_profile into v_compliance_profile from tenant where id = v_tenant_id;
    if coalesce(v_compliance_profile, 'basic') <> 'basic' then
      v_due_on := fn_add_working_days((v_completed_at_after at time zone 'utc')::date, 10);
      insert into compliance_deadline (tenant_id, job_id, kind, due_on)
      values (v_tenant_id, p_job_id, 'termo', v_due_on);
    end if;
  end if;

  v_result := jsonb_build_object('client_mutation_id', p_client_mutation_id, 'status', 'applied', 'closeout_id', v_closeout.id);

  insert into applied_mutation (client_mutation_id, tenant_id, mutation_type, result)
  values (p_client_mutation_id, v_tenant_id, 'closeout.submit', v_result);

  return v_result;
end;
$$;

revoke execute on function rpc_closeout_submit(uuid, uuid, boolean, text, text, text) from public;
grant execute on function rpc_closeout_submit(uuid, uuid, boolean, text, text, text) to authenticated;

-- rpc_dispatch_job: port of apps/api/src/domain/dispatch-gate.ts's
-- evaluateDispatchGate() plus routes/jobs.ts's POST /jobs/:id/dispatch
-- wrapper (the wrong_status precondition and the status flip) — one atomic
-- function instead of a check-then-separate-write, closing the exact race
-- §4 names: "a client could observe (or worse, act on) a job that passed
-- the gate a moment ago but no longer would." Not part of the sync-mutation
-- family (no client_mutation_id/applied_mutation bookkeeping) — dispatch
-- was never a queued offline mutation in the original design either, it's
-- a direct, synchronous office-side action.
create or replace function rpc_dispatch_job(p_job_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_job record;
  v_compliance_profile text;
  v_blocking jsonb := '[]'::jsonb;
  v_item record;
  v_van_scoped_exists boolean;
  v_latest_audit record;
  v_stale boolean;
  v_instrument_ids uuid[];
  v_instrument_id uuid;
  v_eq record;
  v_today date := (now() at time zone 'utc')::date;
  v_updated record;
begin
  -- Security review (high, confirmed): a plain, unlocked read here defeated
  -- the exact TOCTOU guarantee this whole function exists to provide (per
  -- its own comment above) — two genuinely concurrent dispatch calls on the
  -- same ready_check job could both pass the wrong_status/gate checks
  -- before either committed, then both reach the status-flip UPDATE below,
  -- with the second succeeding against an already-dispatched row instead of
  -- correctly failing wrong_status. FOR UPDATE serializes this the standard
  -- way: the second call blocks here until the first commits, then
  -- correctly observes status='dispatched' and returns wrong_status. The
  -- final UPDATE's own `and status = 'ready_check'` guard (below) is a
  -- second, independent check — belt and suspenders, not a substitute for
  -- this lock.
  select id, status, ited_classification, ited_classification_by, test_protocol_snapshot
    into v_job
    from job where id = p_job_id for update;

  if not found then
    return jsonb_build_object('kind', 'not_found');
  end if;

  if v_job.status <> 'ready_check' then
    return jsonb_build_object('kind', 'wrong_status', 'status', v_job.status);
  end if;

  select coalesce(compliance_profile, 'basic') into v_compliance_profile
  from tenant where id = fn_current_tenant_id();

  -- (a) every mandatory scope='job' checklist item has status='ok'
  for v_item in
    select id, label from job_checklist_item
    where job_id = p_job_id and scope = 'job' and mandatory = true and status <> 'ok'
    order by label
  loop
    v_blocking := v_blocking || jsonb_build_object('kind', 'checklist_item', 'item_id', v_item.id, 'label', v_item.label);
  end loop;

  -- (b) scope='van' items covered by a not-stale van_audit — tenant-wide v1
  -- simplification, same as the TS version (no job-to-van assignment modeled).
  select exists(
    select 1 from job_checklist_item where job_id = p_job_id and scope = 'van'
  ) into v_van_scoped_exists;

  if v_van_scoped_exists then
    select van_label, next_due_at into v_latest_audit
    from van_audit order by performed_at desc limit 1;

    v_stale := (not found) or v_latest_audit.next_due_at < now();
    if v_stale then
      v_blocking := v_blocking || jsonb_build_object(
        'kind', 'van_audit_stale',
        'van_label', case when found then v_latest_audit.van_label else null end,
        'next_due_at', case when found then v_latest_audit.next_due_at else null end
      );
    end if;
  end if;

  -- (c) every instrument referenced by the resolved test_protocol_snapshot
  -- has current calibration — same defensive "vacuously satisfied when no
  -- test entry carries instrument_id" reasoning as the TS version, since
  -- the seeded/verified test_protocol body shape has no such linkage today.
  -- Security review (low, confirmed): `array_agg(distinct ...)` sorts by
  -- value rather than preserving first-appearance order the way
  -- dispatch-gate.ts's `Array.from(new Set(...))` does — currently
  -- unreachable (nothing populates instrument_id yet) but a real divergence
  -- once it is. Fixed below to dedupe by minimum ordinal per instrument_id,
  -- then order the final array by that ordinal — the same "first
  -- appearance wins" semantics a Set gives, not an accident of uuid
  -- byte-value sort order.
  select array_agg(instrument_id order by first_ord)
    into v_instrument_ids
  from (
    select (t->>'instrument_id')::uuid as instrument_id, min(ord) as first_ord
    from jsonb_array_elements(coalesce(v_job.test_protocol_snapshot->'tests', '[]'::jsonb))
         with ordinality as arr(t, ord)
    where t->>'instrument_id' is not null
    group by (t->>'instrument_id')::uuid
  ) dedup;

  if v_instrument_ids is not null then
    foreach v_instrument_id in array v_instrument_ids loop
      select id, kind, calibration_expires_on into v_eq
      from equipment where id = v_instrument_id;

      if not found or v_eq.calibration_expires_on is null or v_eq.calibration_expires_on < v_today then
        v_blocking := v_blocking || jsonb_build_object(
          'kind', 'calibration_expired',
          'equipment_id', v_instrument_id,
          'kind_label', case when found then v_eq.kind else 'unknown' end,
          'expired_on', case when found then v_eq.calibration_expires_on else null end
        );
      end if;
    end loop;
  end if;

  -- (d) non-basic tenants require an actual human review of ited_classification
  if v_compliance_profile <> 'basic' and v_job.ited_classification_by is null then
    v_blocking := v_blocking || jsonb_build_object(
      'kind', 'ited_classification_unreviewed',
      'job_id', p_job_id,
      'ited_classification', v_job.ited_classification
    );
  end if;

  if jsonb_array_length(v_blocking) > 0 then
    return jsonb_build_object('kind', 'not_ready', 'blocking', v_blocking);
  end if;

  update job set status = 'dispatched'
  where id = p_job_id and status = 'ready_check'
  returning readiness_snapshot, execution_snapshot, test_protocol_snapshot into v_updated;

  if not found then
    -- Should be unreachable given the FOR UPDATE lock above already
    -- serializes this — kept as an independent, second guard rather than
    -- trusting the lock alone to hold forever under every future edit.
    return jsonb_build_object('kind', 'wrong_status', 'status', 'dispatched');
  end if;

  return jsonb_build_object(
    'kind', 'ok',
    'readiness_snapshot', v_updated.readiness_snapshot,
    'execution_snapshot', v_updated.execution_snapshot,
    'test_protocol_snapshot', v_updated.test_protocol_snapshot
  );
end;
$$;

revoke execute on function rpc_dispatch_job(uuid) from public;
grant execute on function rpc_dispatch_job(uuid) to authenticated;

-- ============================================================================
-- Final Step 4 slice: rpc_create_job_from_quote(). Port of
-- apps/api/src/domain/job-creation.ts's createJobFromQuote() PLUS
-- apps/api/src/routes/quotes.ts's POST /quotes/:id/create-job wrapper (quote
-- validation, collision-safe JOB-XXXX code generation, job row insertion) —
-- one atomic function instead of a route that calls a domain function inside
-- one Fastify-managed transaction, same reasoning every other RPC in this
-- file already follows.
--
-- ============================================================================

-- fn_slugify: a security review of this file's first draft (unaccent()-
-- based) found and independently confirmed a real divergence from
-- job-creation.ts's slugify() for the Portuguese ordinal indicators º/ª
-- (everyday PT business text — floor numbers, "nº") and several other
-- extended-Latin characters (ß, œ, æ, ł, dotless ı): unaccent()'s
-- translation table *expands* these into extra ASCII letters (º -> "o",
-- ß -> "ss"), while slugify()'s actual algorithm — NFD-normalize, then
-- strip ONLY the Unicode combining-marks block (̀-ͯ) — leaves
-- characters with no canonical NFD decomposition untouched, so they fall
-- through to the non-alphanumeric collapse and get dropped/hyphenated
-- instead. unaccent() was never actually equivalent to what slugify() does;
-- it was a broader, different transformation that happened to agree on the
-- standard-Portuguese-diacritics subset the first five test strings covered.
--
-- Fixed by using Postgres's native normalize(text, form) (built in since
-- PG13, no extension needed) to replicate the JS algorithm literally
-- instead of approximating it with a different one: NFD-normalize, strip
-- the same ̀-ͯ combining-marks range slugify()'s own regex names,
-- lowercase, collapse non-alphanumeric runs to a hyphen, trim. Re-verified
-- against 18 real test strings this time — every case the review found
-- diverging (º/ª ordinals, ß, œ, æ, ł, dotless ı) plus digits-only,
-- punctuation-only, already-hyphenated, empty string, and non-Latin scripts
-- (CJK, Cyrillic) — all byte-for-byte identical to the real JS output, not
-- assumed from reading the two algorithms side by side.
create or replace function fn_slugify(p_input text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(
    regexp_replace(normalize(lower(p_input), NFD), '[̀-ͯ]', '', 'g'),
    '[^a-z0-9]+', '-', 'g'
  ));
$$;

revoke execute on function fn_slugify(text) from public;
grant execute on function fn_slugify(text) to authenticated;

-- fn_infer_network_type: literal port of job-creation.ts's
-- inferNetworkTypeFromJobType() — same keyword lists, same priority order
-- (FO checked before CC before SMATV before PC, since "coax"/"coaxial"
-- would otherwise ambiguously match both the CC and SMATV branches).
create or replace function fn_infer_network_type(p_job_type text)
returns text
language plpgsql
immutable
as $$
declare
  v_tokens text[];
begin
  v_tokens := string_to_array(fn_slugify(p_job_type), '-');
  if v_tokens && array['fibra','fibre','optica','otica','fo'] then return 'FO'; end if;
  if v_tokens && array['coletiva','colectiva'] then return 'CC'; end if;
  if v_tokens && array['tdt','coax','coaxial','smatv','sat','antena','mastro'] then return 'SMATV'; end if;
  if v_tokens && array['estruturada','cablagem','utp','ftp','rj45','cat6','cat5e'] then return 'PC'; end if;
  return null;
end;
$$;

revoke execute on function fn_infer_network_type(text) from public;
grant execute on function fn_infer_network_type(text) to authenticated;

-- rpc_create_job_from_quote: the full port. Not part of the sync-mutation
-- family (no client_mutation_id) — job creation from an accepted quote was
-- never a queued offline mutation in the original design either, it's a
-- direct, synchronous office-side action, same category as
-- rpc_dispatch_job.
--
-- FOR UPDATE on the quote row is added here even though the reference
-- implementation has no equivalent lock — worth being explicit about what
-- it does and doesn't buy: quote.status never transitions away from
-- 'accepted' after a job is created (matching the TS version exactly, not
-- a gap introduced here), so nothing prevents a SECOND, later, sequential
-- call on the same already-accepted quote from creating a second job — the
-- lock only closes the narrower window of two truly *simultaneous* calls
-- racing each other, it does not retroactively invent a one-job-per-quote
-- invariant the original system never had. Not fixed into different
-- behavior here, per this file's own standing rule for every other port.
create or replace function rpc_create_job_from_quote(p_quote_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_quote record;
  v_slug text;
  v_compliance_profile text;
  v_readiness_body jsonb;
  v_execution_body jsonb;
  v_test_protocol_body jsonb;
  v_network_type text;
  v_code text;
  v_attempt int := 0;
  v_candidate text;
  v_candidate_exists boolean;
  v_job_id uuid;
  v_item jsonb;
  v_covered_item_ids uuid[] := array[]::uuid[];
  v_item_id uuid;
  v_qty numeric;
  v_mandatory boolean;
  v_by_job int := 0;
  v_by_van int := 0;
  v_by_office int := 0;
  v_line record;
  v_merged_from_quote int := 0;
begin
  v_tenant_id := fn_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'rpc_create_job_from_quote: no tenant context resolved for this session';
  end if;

  select client_id, job_type, quoted_hours, quoted_materials, status
    into v_quote
    from quote where id = p_quote_id for update;

  if not found then
    return jsonb_build_object('kind', 'not_found');
  end if;

  if v_quote.status <> 'accepted' then
    return jsonb_build_object('kind', 'not_accepted');
  end if;

  -- Collision-safe JOB-<4-digit> code, same check-then-insert retry loop
  -- (up to 20 attempts) as routes/quotes.ts.
  while v_code is null and v_attempt < 20 loop
    v_attempt := v_attempt + 1;
    v_candidate := 'JOB-' || (1000 + floor(random() * 9000))::int::text;
    select exists(select 1 from job where tenant_id = v_tenant_id and code = v_candidate) into v_candidate_exists;
    if not v_candidate_exists then
      v_code := v_candidate;
    end if;
  end loop;

  if v_code is null then
    return jsonb_build_object('kind', 'code_collision');
  end if;

  insert into job (tenant_id, quote_id, client_id, code, title, job_type, quoted_hours, quoted_materials)
  values (v_tenant_id, p_quote_id, v_quote.client_id, v_code, v_quote.job_type, v_quote.job_type, v_quote.quoted_hours, v_quote.quoted_materials)
  returning id into v_job_id;

  -- createJobFromQuote's own work starts here: resolve templates, tenant
  -- layer preferred over system (order by (t.layer='tenant') desc), same
  -- RLS-scoped visibility rule every other resolution query in this
  -- codebase already relies on rather than a redundant explicit filter.
  v_slug := fn_slugify(v_quote.job_type);

  select compliance_profile into v_compliance_profile from tenant where id = v_tenant_id;
  v_compliance_profile := coalesce(v_compliance_profile, 'basic');

  select tv.body into v_readiness_body
  from template t join template_version tv on tv.template_id = t.id
  where t.kind = 'checklist' and t.code = ('readiness_' || v_slug) and tv.status = 'active'
  order by (t.layer = 'tenant') desc
  limit 1;

  select tv.body into v_execution_body
  from template t join template_version tv on tv.template_id = t.id
  where t.kind = 'execution_steps' and t.code = ('execution_' || v_slug) and tv.status = 'active'
  order by (t.layer = 'tenant') desc
  limit 1;

  if v_compliance_profile <> 'basic' then
    v_network_type := fn_infer_network_type(v_quote.job_type);
    if v_network_type is not null then
      select tv.body into v_test_protocol_body
      from template t join template_version tv on tv.template_id = t.id
      where t.kind = 'test_protocol' and tv.status = 'active' and tv.body->>'network_type' = v_network_type
      order by (t.layer = 'tenant') desc, t.code
      limit 1;
    end if;
  end if;

  -- Materialize job_checklist_item rows from the resolved readiness
  -- checklist, tracking covered catalog item_ids the same way the TS
  -- version's coveredItemIds Set does, so the quote-line merge below
  -- doesn't duplicate them.
  for v_item in select * from jsonb_array_elements(coalesce(v_readiness_body->'items', '[]'::jsonb))
  loop
    v_item_id := nullif(v_item->>'item_id', '')::uuid;
    v_qty := coalesce((v_item->>'qty')::numeric, 1);
    v_mandatory := coalesce((v_item->>'mandatory')::boolean, true);

    insert into job_checklist_item (tenant_id, job_id, cat, label, qty, item_id, scope, mandatory, status)
    values (v_tenant_id, v_job_id, v_item->>'cat', v_item->>'label', v_qty, v_item_id, v_item->>'scope', v_mandatory, 'missing');

    if v_item->>'scope' = 'job' then v_by_job := v_by_job + 1;
    elsif v_item->>'scope' = 'van' then v_by_van := v_by_van + 1;
    elsif v_item->>'scope' = 'office' then v_by_office := v_by_office + 1;
    end if;

    if v_item_id is not null then
      v_covered_item_ids := array_append(v_covered_item_ids, v_item_id);
    end if;
  end loop;

  -- Merge quote_line rows not already covered by the resolved checklist —
  -- a line with no item_id always merges; a line with an item_id merges
  -- only if that item_id wasn't already materialized above.
  for v_line in select item_id, description, qty from quote_line where quote_id = p_quote_id
  loop
    if v_line.item_id is not null and v_line.item_id = any(v_covered_item_ids) then
      continue;
    end if;

    insert into job_checklist_item (tenant_id, job_id, cat, label, qty, item_id, scope, mandatory, status)
    values (v_tenant_id, v_job_id, 'material', v_line.description, v_line.qty, v_line.item_id, 'job', true, 'missing');

    v_by_job := v_by_job + 1;
    v_merged_from_quote := v_merged_from_quote + 1;
    if v_line.item_id is not null then
      v_covered_item_ids := array_append(v_covered_item_ids, v_line.item_id);
    end if;
  end loop;

  -- Freeze the resolved bodies into the job row, verbatim, once
  -- (architecture §5's "resolved once, never re-read" rule).
  update job
  set readiness_snapshot = v_readiness_body,
      execution_snapshot = v_execution_body,
      test_protocol_snapshot = v_test_protocol_body
  where id = v_job_id;

  return jsonb_build_object(
    'kind', 'ok',
    'job_id', v_job_id,
    'code', v_code,
    'checklist', jsonb_build_object(
      'total', v_by_job + v_by_van + v_by_office,
      'by_scope', jsonb_build_object('job', v_by_job, 'van', v_by_van, 'office', v_by_office),
      'merged_from_quote', v_merged_from_quote
    ),
    'has_execution_snapshot', v_execution_body is not null,
    'has_test_protocol_snapshot', v_test_protocol_body is not null
  );
end;
$$;

revoke execute on function rpc_create_job_from_quote(uuid) from public;
grant execute on function rpc_create_job_from_quote(uuid) to authenticated;

-- ============================================================================
-- End of §6 Step 4 / §4's RPC-porting scope. All six candidates named in the
-- design doc are now ported: the five sync mutations (checklist_item.update
-- from Step 3; execution_step.complete, test_result.record,
-- van_audit.record, closeout.submit from earlier in this slice),
-- rpc_dispatch_job, and rpc_create_job_from_quote. Remaining work per §6:
-- table-by-table cutover of the rest of the surface (step 4's broader scope)
-- and final cutover (step 5) — not RPC authoring, wiring apps/web to call
-- these instead of Fastify.
-- ============================================================================

-- ============================================================================
-- §6 Step 5: apps/web office job-detail cutover. One new RPC needed beyond
-- §4's six named candidates — POST /jobs/:id/complete
-- (routes/jobs.ts) was never in that list because Step 4's scope was
-- exactly the six the design doc named, not a claim that nothing else ever
-- needed one. It qualifies on the same grounds rpc_dispatch_job already
-- did: a read-decide-write sequence (status/completed_at precondition,
-- conditional compliance_deadline insert) that a client observing it
-- through several separate calls could race the same way §4 warned about.
-- ============================================================================

-- rpc_job_complete: port of routes/jobs.ts's POST /jobs/:id/complete
-- (which itself is not domain/closeout.ts's submitCloseout() — a distinct,
-- earlier transition: dispatched/in_progress/testing -> testing, stamping
-- completed_at, for the office two-step flow's first step). Not a sync
-- mutation (no client_mutation_id/applied_mutation bookkeeping) — like
-- dispatch, this was never a queued offline mutation, it's a direct,
-- synchronous office-side action.
--
-- FOR UPDATE added here though the Fastify original never had it — the
-- Fastify route's plain read-then-write has the exact same TOCTOU shape
-- rpc_dispatch_job's own comment already documents and fixes for its
-- sibling race: two genuinely concurrent /complete calls on the same job
-- could both observe completed_at=null before either commits, and both
-- insert a termo compliance_deadline row (no unique(job_id, kind)
-- constraint catches the duplicate). Applying the same established fix here
-- rather than porting the unlocked read literally, since faithfully
-- reproducing a race this codebase has already named and fixed twice would
-- be reproducing a known bug, not preserving intended behavior.
create or replace function rpc_job_complete(p_job_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_job record;
  v_updated record;
  v_compliance_profile text;
  v_due_on date;
begin
  v_tenant_id := fn_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'rpc_job_complete: no tenant context resolved for this session';
  end if;

  select id, status, completed_at into v_job from job where id = p_job_id for update;
  if not found then
    return jsonb_build_object('kind', 'not_found');
  end if;

  if v_job.completed_at is not null or v_job.status not in ('dispatched', 'in_progress', 'testing') then
    return jsonb_build_object(
      'kind', 'conflict', 'status', v_job.status, 'completed_at', v_job.completed_at
    );
  end if;

  update job set completed_at = now(), status = 'testing'
  where id = p_job_id
  returning id, status, completed_at into v_updated;

  select coalesce(compliance_profile, 'basic') into v_compliance_profile
  from tenant where id = v_tenant_id;

  if v_compliance_profile <> 'basic' then
    v_due_on := fn_add_working_days((v_updated.completed_at at time zone 'utc')::date, 10);
    insert into compliance_deadline (tenant_id, job_id, kind, due_on)
    values (v_tenant_id, p_job_id, 'termo', v_due_on);
  end if;

  return jsonb_build_object(
    'kind', 'ok', 'id', v_updated.id, 'status', v_updated.status, 'completed_at', v_updated.completed_at
  );
end;
$$;

comment on function rpc_job_complete(uuid) is
  '§6 Step 5. SECURITY INVOKER — RLS on job/tenant/compliance_deadline is what '
  'actually restricts this. FOR UPDATE closes a TOCTOU race the ported Fastify '
  'route never had a guard against (see comment above); everything else is a '
  'literal port of routes/jobs.ts''s POST /jobs/:id/complete.';

revoke execute on function rpc_job_complete(uuid) from public;
grant execute on function rpc_job_complete(uuid) to authenticated;

-- rpc_closeout_set_rework_cause: port of routes/jobs.ts's
-- PATCH /jobs/:id/closeout/rework-cause. Turned out to need an RPC after
-- all, not the plain client-side `.update()` this comment originally
-- expected — not for atomicity, but because rework_cause_set_by must be
-- resolved server-side from the calling session the same way every other
-- attribution column in this codebase is (ited_classification_by,
-- updated_by, closed_by, completed_by, performed_by): a client-supplied
-- value there would let any caller claim any app_user id, the kind of gap
-- RLS-as-sole-boundary is supposed to close, not reopen. fn_current_app_user_id()
-- is SECURITY DEFINER precisely so a plain RLS-scoped write couldn't do
-- this lookup for itself (schema.sql's own comment on that function) —
-- calling it from inside a SECURITY INVOKER RPC, the same way
-- rpc_closeout_submit already does, is the correct shape, not a workaround.
--
-- Role gating (technician_cannot_set_rework_cause in the Fastify version) —
-- §6 Step 5 review finding (low, confirmed): the comment that used to
-- stand here argued this was safe to skip since technician auth isn't
-- migrated to Supabase yet, so no technician session could call this at
-- all — true today, but not something this function itself enforced, only
-- an operational fact scheduled to stop being true. Ported for real instead
-- of left as a documented gap: same defense-in-depth reasoning as every
-- other belt-and-suspenders role check in this codebase (RLS restricts by
-- tenant, this restricts by role — PRD §6, "rework_cause is office-only").
--
-- Two more review findings (both confirmed): the emptiness guard used to be
-- `length(trim(p_rework_cause)) = 0` — Postgres's bare trim()/btrim()
-- strips only the ASCII space character by default, not tab/newline/CR, so
-- a whitespace-only value using any of those would have slipped through as
-- "non-empty". `!~ '\S'` (no non-whitespace character present) is correct
-- for any whitespace. And this function used to never resolve/guard
-- fn_current_tenant_id() at all, unlike every sibling in this file — RLS on
-- job_closeout still makes that safe on its own (a null tenant context
-- makes the policy's `tenant_id = null` comparison false for every row, so
-- the UPDATE just matches nothing and returns not_found), but the explicit
-- guard is added anyway for the same early, unambiguous diagnostic every
-- other function in this file gets, not because RLS needed the backup.
create or replace function rpc_closeout_set_rework_cause(p_job_id uuid, p_rework_cause text)
returns jsonb
language plpgsql
as $$
declare
  v_tenant_id uuid;
  v_app_user_id uuid;
  v_role text;
  v_row record;
begin
  v_tenant_id := fn_current_tenant_id();
  if v_tenant_id is null then
    raise exception 'rpc_closeout_set_rework_cause: no tenant context resolved for this session';
  end if;

  if p_rework_cause is null or p_rework_cause !~ '\S' then
    raise exception 'rpc_closeout_set_rework_cause: rework_cause must be non-empty';
  end if;

  v_app_user_id := fn_current_app_user_id();

  select role into v_role from app_user where id = v_app_user_id;
  if v_role = 'technician' then
    raise exception 'rpc_closeout_set_rework_cause: rework_cause is office-only (PRD §6)';
  end if;

  update job_closeout
  set rework_cause = p_rework_cause, rework_cause_set_by = v_app_user_id
  where job_id = p_job_id
  returning id, rework_cause, rework_cause_set_by into v_row;

  if not found then
    return jsonb_build_object('kind', 'not_found');
  end if;

  return jsonb_build_object(
    'kind', 'ok', 'id', v_row.id, 'rework_cause', v_row.rework_cause, 'rework_cause_set_by', v_row.rework_cause_set_by
  );
end;
$$;

comment on function rpc_closeout_set_rework_cause(uuid, text) is
  '§6 Step 5. SECURITY INVOKER — RLS on job_closeout is what actually '
  'restricts this; fn_current_app_user_id() (SECURITY DEFINER) resolves the '
  'attribution the same way every other RPC in this file does, so this '
  'function does not need to be one itself.';

revoke execute on function rpc_closeout_set_rework_cause(uuid, text) from public;
grant execute on function rpc_closeout_set_rework_cause(uuid, text) to authenticated;

-- ============================================================================
-- End of the §6 Step 5 additions (rpc_job_complete,
-- rpc_closeout_set_rework_cause). apps/web's office job-detail page
-- (dispatch, checklist, execution steps, test results, complete, closeout,
-- rework-cause) now has an RPC for every write it makes except photo upload
-- (binary bytes; stays a Fastify route, same as REF PDF generation and
-- Veryfi OCR — structurally can't be an RPC, §4).
-- ============================================================================
