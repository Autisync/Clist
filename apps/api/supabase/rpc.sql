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
-- End of this slice. Deliberately not here yet: create_job_from_quote() —
-- genuinely more complex (slugification, two template-coding conventions,
-- checklist materialization, quote-line merge) and gets its own slice.
-- ============================================================================
