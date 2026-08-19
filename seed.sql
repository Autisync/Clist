-- ============================================================================
-- FieldReady — seed data
-- v1.0 · 18 August 2026
--
-- Demonstrates the ited_full compliance gate (03-schema.sql §4,
-- fn_activate_template_version_guard) satisfied with real data, not
-- bypassed: two system-layer test_protocol template versions, published and
-- active, each carrying verified_by/verified_source citing the real Manual
-- ITED 4.ª ed. tables retrieved directly by Rex on 18 August 2026
-- (ited-ref-mapping.md §7A.3, forms-and-procedures-spec.md §3.4).
--
-- Run after 03-schema.sql, as a role that owns the tables (fieldready_migrator
-- or equivalent) — this script does not SET LOCAL app.current_tenant_id or
-- switch role, so it runs above RLS the same way verify-schema.mjs's fixture
-- inserts do. Verify with: node verify-seed.mjs
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A minimal internal tenant + user to hold the identity of whoever verified
-- these system templates. Not a real installer — a FieldReady compliance
-- reviewer, same shape as any other app_user row. verified_by is only a
-- foreign key to establish accountability for the numbers; it is RLS on
-- template/template_version (03-schema.sql §12) that actually governs who
-- can see what, and system templates (tenant_id null) are already visible to
-- every tenant regardless of who verified them.
-- ----------------------------------------------------------------------------

insert into tenant (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'FieldReady — compliance review', 'fieldready-internal');

insert into app_user (id, tenant_id, role, full_name, email)
values (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'office',
  'Rex — compliance reviewer',
  'dpolisousa@gmail.com'
);

-- ----------------------------------------------------------------------------
-- F13 · Coaxial S/MATV, per-outlet (TT) test protocol
--
-- Tabela 6.12, Manual ITED 4.ª ed., p.170 — nível de sinal e MER only, split
-- by modulation. This is the TT/tomada test — what a technician measures on
-- the phone flow — not the separate entrada-da-CR test (Tabela 6.13), which
-- is a head-end commissioning step out of scope for this template. See
-- ited-ref-mapping.md §7A.3 for the full structural note this corrects (the
-- prototype's original TDT_TESTS conflated the two test points).
-- ----------------------------------------------------------------------------

insert into template (id, tenant_id, layer, kind, code, title)
values (
  '00000000-0000-0000-0000-000000000010',
  null, 'system', 'test_protocol', 'coax_smatv_tt_tabela_6_12',
  'Coaxial S/MATV — ensaio na tomada (TT), Tabela 6.12'
);

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
);

-- ----------------------------------------------------------------------------
-- F14 · Fibra ótica test protocol
--
-- Tabela 6.17, Manual ITED 4.ª ed., p.174 — atenuação limite at both
-- wavelengths in use on Portuguese FO installs.
-- ----------------------------------------------------------------------------

insert into template (id, tenant_id, layer, kind, code, title)
values (
  '00000000-0000-0000-0000-000000000020',
  null, 'system', 'test_protocol', 'fibra_optica_tabela_6_17',
  'Fibra ótica — atenuação, Tabela 6.17'
);

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
);

-- ----------------------------------------------------------------------------
-- F12 · Coaxial — rede coletiva e individual (CC), Tabela 6.7/6.9
--
-- network_type "CC" — not "SMATV", which F13 already owns (confirmed against
-- 03-schema.sql's own network_type check constraint and F13's body above).
-- Atenuação/slope limits, Manual ITED 4.ª ed., pp.166-167:
--   - Coletiva (Tabela 6.7) and individual (Tabela 6.9), 47-862 MHz: 13,8 dB
--     atenuação / 10,8 dB slope, both networks.
--   - Individual only (Tabela 6.9), 950-2150 MHz (banda FI satélite): 23,4 dB
--     atenuação / 8,4 dB slope.
-- Classe de ligação garantida: TCD-C-M (Tabela 6.4/6.5, método 6.2.1).
-- See forms-and-procedures-spec.md §3.4, ited-ref-mapping.md §7A.3.
-- ----------------------------------------------------------------------------

insert into template (id, tenant_id, layer, kind, code, title)
values (
  '00000000-0000-0000-0000-000000000030',
  null, 'system', 'test_protocol', 'coax_cc_tabela_6_7_6_9',
  'Coaxial — rede coletiva e individual (CC), Tabela 6.7/6.9'
);

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
);

-- ----------------------------------------------------------------------------
-- F11 · Pares de cobre (PC), Tabela 6.1/6.1.1
--
-- Structurally different from F12/F13/F14, not just another numeric table —
-- see ited-ref-mapping.md §7A.3's addendum ("Tabela 6.1 — ... and why it
-- isn't a numeric-limits table") and 06-phase3-compliance.md §2. Tabela 6.1
-- lists which EN 50173 Classe E link parameters a copper-pair certification
-- must cover; it does not itself define a numeric pass/fail threshold for
-- any of them — that verdict comes from the certifying instrument's own
-- built-in evaluation against EN 50173 Classe E. Forcing a min/max here
-- would mean fabricating an ITED-authored number that does not exist in the
-- source, in front of the exact gate (fn_activate_template_version_guard)
-- built to catch that — so every test below uses
-- dir: "external_pass_fail" (packages/core/src/template.ts,
-- test-protocol-eval.ts) instead: no min/max stored, the certifier's own
-- pass/fail verdict is recorded as-is.
--
-- Length ("Comprimento") is called out in the manual's own footnote 4 as
-- "meramente informativo" — informational only, not a pass/fail gate. There
-- is no per-test `mandatory` flag on TestProtocolTest (checked
-- packages/core/src/template.ts before writing this — only `checklist`
-- items carry that concept) and this seed does not invent one; the caveat
-- is carried in the label/limit_ref text instead. See 06-phase3-compliance.md
-- §2's own instruction not to force-fit a field that doesn't exist in the
-- schema — flagged as a deviation in the phase handoff, not silently added.
-- ----------------------------------------------------------------------------

insert into template (id, tenant_id, layer, kind, code, title)
values (
  '00000000-0000-0000-0000-000000000040',
  null, 'system', 'test_protocol', 'pares_cobre_tabela_6_1',
  'Pares de cobre (PC) — Tabela 6.1/6.1.1 (EN 50173 Classe E)'
);

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
);
