-- ============================================================================
-- FieldReady — Supabase-native seed data. §6 Step 5 (real cutover begins).
--
-- Faithful port of ../../seed.sql — the SAME real Manual ITED 4.ª ed. numeric
-- limits (F11 pares de cobre, F12 coaxial CC, F13 coaxial S/MATV, F14 fibra
-- ótica), byte-for-byte identical bodies, same verified_source citations, same
-- fixed UUIDs (kept identical across both schemas deliberately — these are
-- already referenced by id in comments/docs across the codebase, and there's
-- no reason for the Supabase-native copy to diverge from them). This is NOT
-- a test fixture like the verify-*.mjs scripts' throwaway data — it's real
-- reference data meant to persist on the live project, so unlike every
-- verify-*.mjs script in this folder, this one is idempotent via
-- `on conflict (id) do nothing`, never drop-and-reapply.
--
-- Unlike the root seed.sql, the "compliance reviewer" app_user here has no
-- auth_user_id (nullable, §2) — it exists purely as the verified_by
-- foreign key for accountability, exactly as the root seed.sql's own comment
-- already explains ("Not a real installer... verified_by is only a foreign
-- key to establish accountability"). It never needs to log in, so it never
-- needs a real Supabase Auth account — same reasoning technician app_user
-- rows already rely on.
--
-- Run with: npm run seed:supabase (from the repo root) — see
-- apps/api/supabase/apply-seed.mjs for the idempotent-apply wrapper.
-- ============================================================================

insert into tenant (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'FieldReady — compliance review', 'fieldready-internal')
on conflict (id) do nothing;

insert into app_user (id, tenant_id, role, full_name, email)
values (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'office',
  'Rex — compliance reviewer',
  'dpolisousa@gmail.com'
)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- F13 · Coaxial S/MATV, per-outlet (TT) test protocol — Tabela 6.12
-- ----------------------------------------------------------------------------

insert into template (id, tenant_id, layer, kind, code, title)
values (
  '00000000-0000-0000-0000-000000000010',
  null, 'system', 'test_protocol', 'coax_smatv_tt_tabela_6_12',
  'Coaxial S/MATV — ensaio na tomada (TT), Tabela 6.12'
)
on conflict (id) do nothing;

insert into template_version (
  id, template_id, version, status, body,
  effective_from, published_at, published_by,
  verified_by, verified_source, verified_at
)
values (
  '00000000-0000-0000-0000-000000000011',
  '00000000-0000-0000-0000-000000000010',
  1, 'active',
  '{
    "network_type": "SMATV",
    "tests": [
      {"id": "nivel_sinal_hertziana", "label": "Nível de sinal — TDT hertziana (64QAM, Zona A)", "unit": "dBµV", "dir": "range", "min": 45, "max": 74, "recommended": 55, "limit_ref": "Tabela 6.12"},
      {"id": "mer_hertziana", "label": "MER — TDT hertziana (64QAM, Zona A)", "unit": "dB", "dir": "min", "min": 19.5, "recommended": 26, "limit_ref": "Tabela 6.12"},
      {"id": "nivel_sinal_satelite", "label": "Nível de sinal — TDT satélite (8PSK, Zona B)", "unit": "dBµV", "dir": "range", "min": 47, "max": 77, "recommended": 55, "limit_ref": "Tabela 6.12"},
      {"id": "mer_satelite", "label": "MER — TDT satélite (8PSK, Zona B)", "unit": "dB", "dir": "min", "min": 14, "recommended": 17, "limit_ref": "Tabela 6.12"}
    ]
  }'::jsonb,
  now(), now(), '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000002',
  'Manual ITED 4.ª ed. (2019), p.170, Tabela 6.12 — Valores limite de nível de sinal e MER. '
  'Source: ManualITED4edicao_2019.pdf, retrieved directly by Rex 18 Aug 2026, pages 165-176 read '
  'in full. See ited-ref-mapping.md §7A.3.',
  now()
)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- F14 · Fibra ótica test protocol — Tabela 6.17
-- ----------------------------------------------------------------------------

insert into template (id, tenant_id, layer, kind, code, title)
values (
  '00000000-0000-0000-0000-000000000020',
  null, 'system', 'test_protocol', 'fibra_optica_tabela_6_17',
  'Fibra ótica — atenuação, Tabela 6.17'
)
on conflict (id) do nothing;

insert into template_version (
  id, template_id, version, status, body,
  effective_from, published_at, published_by,
  verified_by, verified_source, verified_at
)
values (
  '00000000-0000-0000-0000-000000000021',
  '00000000-0000-0000-0000-000000000020',
  1, 'active',
  '{
    "network_type": "FO",
    "tests": [
      {"id": "atenuacao_1310nm", "label": "Atenuação — 1310 nm", "unit": "dB", "dir": "max", "max": 1.8, "limit_ref": "Tabela 6.17"},
      {"id": "atenuacao_1550nm", "label": "Atenuação — 1550 nm", "unit": "dB", "dir": "max", "max": 1.8, "limit_ref": "Tabela 6.17"}
    ],
    "categoria_minima_garantida": "OS1a"
  }'::jsonb,
  now(), now(), '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000002',
  'Manual ITED 4.ª ed. (2019), p.174, Tabela 6.17 — Valores limite de atenuação, fibra ótica. '
  'Categoria mínima garantida OS1a. Source: ManualITED4edicao_2019.pdf, retrieved directly by '
  'Rex 18 Aug 2026. See ited-ref-mapping.md §7A.3.',
  now()
)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- F12 · Coaxial — rede coletiva e individual (CC), Tabela 6.7/6.9
-- ----------------------------------------------------------------------------

insert into template (id, tenant_id, layer, kind, code, title)
values (
  '00000000-0000-0000-0000-000000000030',
  null, 'system', 'test_protocol', 'coax_cc_tabela_6_7_6_9',
  'Coaxial — rede coletiva e individual (CC), Tabela 6.7/6.9'
)
on conflict (id) do nothing;

insert into template_version (
  id, template_id, version, status, body,
  effective_from, published_at, published_by,
  verified_by, verified_source, verified_at
)
values (
  '00000000-0000-0000-0000-000000000031',
  '00000000-0000-0000-0000-000000000030',
  1, 'active',
  '{
    "network_type": "CC",
    "classe_ligacao_garantida": "TCD-C-M",
    "tests": [
      {"id": "atenuacao_47_862mhz_coletiva", "label": "Atenuação — rede coletiva, 47–862 MHz", "unit": "dB", "dir": "max", "max": 13.8, "limit_ref": "Tabela 6.7"},
      {"id": "slope_47_862mhz_coletiva", "label": "Slope — rede coletiva, 47–862 MHz", "unit": "dB", "dir": "max", "max": 10.8, "limit_ref": "Tabela 6.7"},
      {"id": "atenuacao_47_862mhz_individual", "label": "Atenuação — rede individual, 47–862 MHz", "unit": "dB", "dir": "max", "max": 13.8, "limit_ref": "Tabela 6.9"},
      {"id": "slope_47_862mhz_individual", "label": "Slope — rede individual, 47–862 MHz", "unit": "dB", "dir": "max", "max": 10.8, "limit_ref": "Tabela 6.9"},
      {"id": "atenuacao_950_2150mhz_individual", "label": "Atenuação — rede individual, banda FI satélite, 950–2150 MHz", "unit": "dB", "dir": "max", "max": 23.4, "limit_ref": "Tabela 6.9"},
      {"id": "slope_950_2150mhz_individual", "label": "Slope — rede individual, banda FI satélite, 950–2150 MHz", "unit": "dB", "dir": "max", "max": 8.4, "limit_ref": "Tabela 6.9"}
    ]
  }'::jsonb,
  now(), now(), '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000002',
  'Manual ITED 4.ª ed. (2019), pp.166-167, Tabela 6.7 (rede coletiva) e Tabela 6.9 (rede '
  'individual) — Valores limite de atenuação e de slope; classe de ligação garantida '
  'TCD-C-M (Tabela 6.4/6.5, método 6.2.1). Source: ManualITED4edicao_2019.pdf, retrieved '
  'directly by Rex 18 Aug 2026, pages 165-176 read in full. See ited-ref-mapping.md §7A.3, '
  'forms-and-procedures-spec.md §3.4.',
  now()
)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- F11 · Pares de cobre (PC), Tabela 6.1/6.1.1 — external_pass_fail, per
-- ited-ref-mapping.md §7A.3's addendum: not a numeric-limits table, deferred
-- to the certifying instrument's own EN 50173 Classe E evaluation.
-- ----------------------------------------------------------------------------

insert into template (id, tenant_id, layer, kind, code, title)
values (
  '00000000-0000-0000-0000-000000000040',
  null, 'system', 'test_protocol', 'pares_cobre_tabela_6_1',
  'Pares de cobre (PC) — Tabela 6.1/6.1.1 (EN 50173 Classe E)'
)
on conflict (id) do nothing;

insert into template_version (
  id, template_id, version, status, body,
  effective_from, published_at, published_by,
  verified_by, verified_source, verified_at
)
values (
  '00000000-0000-0000-0000-000000000041',
  '00000000-0000-0000-0000-000000000040',
  1, 'active',
  '{
    "network_type": "PC",
    "classe_avaliacao": "EN 50173 Classe E",
    "tests": [
      {"id": "return_loss", "label": "Perda de retorno (Return Loss)", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "insertion_loss", "label": "Perda de inserção (Insertion Loss)", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "next", "label": "NEXT", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "psnext", "label": "PSNEXT", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "acr_n", "label": "ACR-N", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "psacr_n", "label": "PSACR-N", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "acr_f", "label": "ACR-F (ELFEXT)", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "psacr_f", "label": "PSACR-F (PSELFEXT)", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "propagation_delay", "label": "Atraso de propagação (Propagation Delay)", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "delay_skew", "label": "Desvio de atraso (Delay Skew)", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "wire_map", "label": "Mapa de fios (Wire Map)", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1"},
      {"id": "length", "label": "Comprimento (Length) — meramente informativo, não é critério de pass/fail (nota 4)", "unit": "", "dir": "external_pass_fail", "limit_ref": "Tabela 6.1/6.1.1, nota 4"}
    ]
  }'::jsonb,
  now(), now(), '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000002',
  'Manual ITED 4.ª ed., Tabela 6.1/6.1.1, p.161–162 — evaluated against EN 50173 Classe E '
  'by the certifying instrument''s own pass/fail; no ITED-specific numeric limit exists for '
  'this network type. Source: ManualITED4edicao_2019.pdf, retrieved directly by Rex 18 Aug '
  '2026, §6.1/6.1.1 (pp.161-163) read in full. See ited-ref-mapping.md §7A.3.',
  now()
)
on conflict (id) do nothing;
