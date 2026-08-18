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

-- ============================================================================
-- Not seeded here, deliberately: F11 (Tabela 6.1, pares de cobre) and F12
-- (Tabela 6.4/6.7/6.9, coax coletiva/individual attenuation-slope). Their
-- real values are documented in forms-and-procedures-spec.md §3.4 and
-- ited-ref-mapping.md §7A.3 but weren't seeded as templates in this pass —
-- add them the same way, following coax_smatv_tt_tabela_6_12 above as the
-- pattern, when F11/F12 are built.
-- ============================================================================
