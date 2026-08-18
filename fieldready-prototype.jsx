import { useState, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid, Legend, Cell,
} from "recharts";
import {
  ClipboardCheck, Package, FileText, Wrench, AlertTriangle, CheckCircle2,
  XCircle, Clock, MapPin, Receipt, TrendingUp, TrendingDown, Store,
  LayoutDashboard, Briefcase, Radio, ArrowRight, Camera, PenTool, Info,
  Smartphone, Mic, Truck, ChevronLeft, Keyboard, Loader2, Navigation,
} from "lucide-react";

/* ============================================================
   FieldReady — prototype
   Vertical: telecom / antenna installation (TDT, SAT, MATV)
   Mock data only. No backend, no persistence.
   ============================================================ */

/* ---------------------------- CATALOG ---------------------------- */

const CATALOG = [
  { id: "i1", sku: "TLV-149901", name: "Antena UHF Televés DAT BOSS LR", unit: "un" },
  { id: "i2", sku: "TLV-5607", name: "Amplificador de mastro 5607 (24V)", unit: "un" },
  { id: "i3", sku: "CX-T100", name: "Cabo coaxial T100 Classe A (rolo 100m)", unit: "rolo" },
  { id: "i4", sku: "FC-F11", name: "Ficha F compressão RG11 (saco 10)", unit: "saco" },
  { id: "i5", sku: "MST-345", name: "Mastro galvanizado 3m Ø45mm", unit: "un" },
  { id: "i6", sku: "SUP-25", name: "Suporte de parede 25cm reforçado", unit: "un" },
  { id: "i7", sku: "PSU-24", name: "Fonte alimentação 24V mastro", unit: "un" },
  { id: "i8", sku: "REP-2S", name: "Repartidor 2 saídas 5-2400MHz", unit: "un" },
  { id: "i9", sku: "TOM-TS", name: "Tomada terminal TV/SAT", unit: "un" },
  { id: "i10", sku: "FIX-M8", name: "Kit fixação M8 + buchas químicas", unit: "kit" },
];

const itemById = (id) => CATALOG.find((c) => c.id === id);

/* --------------------------- SUPPLIERS --------------------------- */
/* location + hours fields are the shape a Google Places sync would fill.
   `placeId` / `syncedAt` mark them as externally sourced. */

const H = (o, c) => ({ open: o, close: c });
const WEEK = (o, c, sat) => [null, H(o, c), H(o, c), H(o, c), H(o, c), H(o, c), sat || null];

const SUPPLIERS = [
  {
    id: "s1", name: "Rexel Portugal — Alfragide", category: "Grossista elétrico/telecom",
    placeId: "ChIJ_mock_rexel_alf", syncedAt: "2026-08-15",
    address: "Estrada de Alfragide 67, 2610-008 Amadora",
    distanceKm: 6.4, phone: "+351 21 471 0000",
    hours: WEEK("08:00", "18:30", null),
    account: "Conta 30 dias · desconto 18%",
  },
  {
    id: "s2", name: "Sonepar Lisboa — Prior Velho", category: "Grossista elétrico",
    placeId: "ChIJ_mock_sonepar_pv", syncedAt: "2026-08-15",
    address: "Rua Cidade de Bissau 8, 2685-223 Prior Velho",
    distanceKm: 11.2, phone: "+351 21 942 0000",
    hours: WEEK("08:30", "18:00", null),
    account: "Conta 30 dias · desconto 15%",
  },
  {
    id: "s3", name: "Casa das Antenas — Amadora", category: "Especialista antenas/SAT",
    placeId: "ChIJ_mock_antenas_amd", syncedAt: "2026-08-16",
    address: "Av. Santos Mattos 14, 2700-757 Amadora",
    distanceKm: 7.8, phone: "+351 21 493 0000",
    hours: WEEK("09:00", "19:00", H("09:00", "13:00")),
    account: "Pronto pagamento",
  },
  {
    id: "s4", name: "Leroy Merlin — Alfragide", category: "Retalho / consumíveis",
    placeId: "ChIJ_mock_lm_alf", syncedAt: "2026-08-16",
    address: "Alfragide Retail Park, 2610-016 Amadora",
    distanceKm: 6.1, phone: "+351 21 000 0000",
    hours: [H("09:00", "20:00"), H("09:00", "22:00"), H("09:00", "22:00"), H("09:00", "22:00"),
            H("09:00", "22:00"), H("09:00", "22:00"), H("09:00", "22:00")],
    account: "Pronto pagamento",
  },
];

/* price rows: current price, previous price, how it was captured, when */
const PRICES = [
  { supplierId: "s1", itemId: "i1", price: 78.4, prev: 74.9, src: "receipt", date: "2026-08-11", doc: "FT 2026/14882" },
  { supplierId: "s1", itemId: "i2", price: 41.2, prev: 41.2, src: "receipt", date: "2026-08-11", doc: "FT 2026/14882" },
  { supplierId: "s1", itemId: "i3", price: 62.0, prev: 58.5, src: "receipt", date: "2026-07-29", doc: "FT 2026/14201" },
  { supplierId: "s1", itemId: "i5", price: 22.9, prev: 22.9, src: "manual", date: "2026-06-02", doc: null },
  { supplierId: "s1", itemId: "i7", price: 18.6, prev: 19.9, src: "receipt", date: "2026-08-11", doc: "FT 2026/14882" },
  { supplierId: "s1", itemId: "i8", price: 4.1, prev: 4.1, src: "receipt", date: "2026-07-29", doc: "FT 2026/14201" },

  { supplierId: "s2", itemId: "i1", price: 81.9, prev: 81.9, src: "manual", date: "2026-05-20", doc: null },
  { supplierId: "s2", itemId: "i3", price: 59.3, prev: 61.0, src: "receipt", date: "2026-08-04", doc: "FT B/9932" },
  { supplierId: "s2", itemId: "i4", price: 9.8, prev: 9.8, src: "receipt", date: "2026-08-04", doc: "FT B/9932" },
  { supplierId: "s2", itemId: "i6", price: 11.4, prev: 12.2, src: "receipt", date: "2026-08-04", doc: "FT B/9932" },
  { supplierId: "s2", itemId: "i9", price: 5.6, prev: 5.6, src: "manual", date: "2026-04-11", doc: null },

  { supplierId: "s3", itemId: "i1", price: 74.5, prev: 74.5, src: "receipt", date: "2026-08-13", doc: "FS 2026/771" },
  { supplierId: "s3", itemId: "i2", price: 38.9, prev: 40.5, src: "receipt", date: "2026-08-13", doc: "FS 2026/771" },
  { supplierId: "s3", itemId: "i4", price: 8.9, prev: 8.9, src: "receipt", date: "2026-08-13", doc: "FS 2026/771" },
  { supplierId: "s3", itemId: "i5", price: 21.5, prev: 21.5, src: "manual", date: "2026-07-01", doc: null },
  { supplierId: "s3", itemId: "i6", price: 10.9, prev: 10.9, src: "receipt", date: "2026-08-13", doc: "FS 2026/771" },
  { supplierId: "s3", itemId: "i9", price: 5.2, prev: 5.2, src: "receipt", date: "2026-08-13", doc: "FS 2026/771" },
  { supplierId: "s3", itemId: "i8", price: 3.8, prev: 4.4, src: "receipt", date: "2026-08-13", doc: "FS 2026/771" },

  { supplierId: "s4", itemId: "i10", price: 14.2, prev: 13.5, src: "receipt", date: "2026-08-09", doc: "TALÃO 4471" },
  { supplierId: "s4", itemId: "i5", price: 27.9, prev: 27.9, src: "manual", date: "2026-06-18", doc: null },
  { supplierId: "s4", itemId: "i6", price: 13.9, prev: 13.9, src: "manual", date: "2026-06-18", doc: null },
];

/* ------------------------- TEST PROTOCOL ------------------------- */
/* Corrected 18 Aug against the real Manual ITED 4.ª ed., Tabela 6.12
   (p.170) — see ited-ref-mapping.md §7A.3 and seed.sql for the source
   citation and the schema-side verified/activated template version this
   mirrors. Two real corrections to the original placeholder version:

   1. Only TWO parameters are measured at the tomada (TT) — nível de sinal
      and MER. CBER, LBER, and C/N are NOT TT-level tests in the real
      standard; they belong to Tabela 6.13, a separate head-end
      (entrada da CR) commissioning test, out of scope for this per-outlet
      screen. Removing them here isn't cutting scope, it's fixing a
      fictional test that was never part of ITED.
   2. Limits are hertziana DVB-T/64QAM values (this job is a TDT terrestrial
      install, Zona digital A): nível de sinal 45–74 dBµV (55 recommended),
      MER ≥ 19,5 dB (26 recommended). Satellite jobs (DVB-S2/8PSK) use a
      different pair — 47–77 dBµV / ≥ 14 dB — see the real table for both. */

const TDT_TESTS = [
  { id: "t1", label: "Nível de sinal na tomada", unit: "dBµV", min: 45, max: 74, dir: "range" },
  { id: "t2", label: "MER", unit: "dB", min: 19.5, dir: "min" },
];

const evalTest = (t, v) => {
  if (v === "" || v === null || v === undefined || isNaN(Number(v))) return "pending";
  const n = Number(v);
  if (t.dir === "range") return n >= t.min && n <= t.max ? "pass" : "fail";
  if (t.dir === "min") return n >= t.min ? "pass" : "fail";
  return n <= t.max ? "pass" : "fail";
};

const threshLabel = (t) =>
  t.dir === "range" ? `${t.min}–${t.max} ${t.unit}`
    : t.dir === "min" ? `≥ ${t.min} ${t.unit}`
      : `≤ ${t.sci ? t.max.toExponential(0) : t.max} ${t.unit}`;

/* ----------------------------- JOBS ------------------------------ */

/* scope decides WHO sees the item and WHEN:
   "job"    → technician's phone, per job. Keep this list to 4–6 items.
   "van"    → covered by the weekly van audit, not re-asked every job.
   "office" → auto-verified in the back office; never shown to the technician. */
const mk = (cat, label, qty, itemId, status, scope = "job", mandatory = true) =>
  ({ id: Math.random().toString(36).slice(2, 9), cat, label, qty, itemId, status, scope, mandatory });

const SCOPE_META = {
  job: { label: "No trabalho", tone: "cyan" },
  van: { label: "Stock carrinha", tone: "zinc" },
  office: { label: "Escritório", tone: "amber" },
};

/* weekly van audit — done once, unhurried, at the warehouse */
const VAN_AUDIT = {
  date: "2026-08-14", by: "Rui A.", nextDue: "2026-08-21", van: "Carrinha 1 · 84-QR-19",
  issues: [
    { itemId: "i3", label: "Cabo coaxial T100", note: "Último rolo acabou no JOB-2033" },
    { itemId: null, label: "Kit crimpar / compressão F", note: "Alicate partido — substituir" },
  ],
};

const JOBS = [
  {
    id: "JOB-2041", title: "Instalação antena TDT — moradia",
    client: "F. Marques", address: "R. Ferreira Borges 88, Campo de Ourique, Lisboa",
    type: "TDT — instalação nova", scheduled: "2026-08-18 09:00",
    quotedHours: 3.5, quotedMaterials: 214.6, tech: "Rui A.",
    status: "ready-check",
    checklist: [
      /* --- the technician's actual list: 5 items --- */
      mk("material", "Antena UHF Televés DAT BOSS LR", 1, "i1", "ok", "job"),
      mk("material", "Amplificador de mastro 5607", 1, "i2", "ok", "job"),
      mk("material", "Mastro galvanizado 3m", 1, "i5", "ok", "job"),
      mk("material", "Fonte alimentação 24V", 1, "i7", "missing", "job"),
      mk("doc", "Ficha de trabalhos em altura assinada", 1, null, "missing", "job"),
      /* --- van stock: covered by the weekly audit --- */
      mk("material", "Cabo coaxial T100 (rolo 100m)", 1, "i3", "missing", "van"),
      mk("material", "Ficha F compressão (saco 10)", 1, "i4", "ok", "van"),
      mk("material", "Suporte parede 25cm", 2, "i6", "ok", "van"),
      mk("material", "Tomada terminal TV/SAT", 3, "i9", "ok", "van"),
      mk("equipment", "Medidor de campo DVB-T2 (calibrado)", 1, null, "ok", "van"),
      mk("equipment", "Escada telescópica 6m", 1, null, "ok", "van"),
      mk("equipment", "Arnês + linha de vida (validade OK)", 1, null, "ok", "van"),
      mk("equipment", "Berbequim SDS + brocas Ø10", 1, null, "ok", "van"),
      mk("equipment", "Kit crimpar / compressão F", 1, null, "missing", "van"),
      /* --- office: auto-verified, never shown on the phone --- */
      mk("doc", "Orçamento assinado pelo cliente", 1, null, "ok", "office"),
      mk("doc", "Autorização de acesso ao telhado", 1, null, "ok", "office"),
      mk("doc", "Comprovativo seguro AT em vigor", 1, null, "ok", "office"),
      mk("doc", "Declaração de conformidade (template)", 1, null, "ok", "office", false),
    ],
  },
  {
    id: "JOB-2038", title: "Upgrade cabeça de rede MATV — prédio 12 frações",
    client: "Cond. Alvalade 34", address: "Av. de Roma 34, Alvalade, Lisboa",
    type: "MATV — upgrade", scheduled: "2026-08-17 08:30",
    quotedHours: 8, quotedMaterials: 1180.0, tech: "Rui A. + Nuno S.",
    status: "in-progress",
    checklist: [
      mk("material", "Antena UHF Televés DAT BOSS LR", 1, "i1", "ok", "job"),
      mk("material", "Cabo coaxial T100 (rolo 100m)", 4, "i3", "ok", "job"),
      mk("material", "Repartidor 2 saídas", 12, "i8", "ok", "job"),
      mk("equipment", "Plataforma elevatória (aluguer)", 1, null, "ok", "job"),
      mk("equipment", "Medidor de campo DVB-T2 (calibrado)", 1, null, "ok", "van"),
      mk("doc", "Ata de condomínio autorizando obra", 1, null, "ok", "office"),
      mk("doc", "Orçamento assinado", 1, null, "ok", "office"),
      mk("doc", "Seguro AT", 1, null, "ok", "office"),
    ],
  },
];

/* completed job history — feeds the dashboard */
const HISTORY = [
  { id: "JOB-2035", type: "SAT+TDT", date: "2026-08-12", quotedH: 5, actualH: 5.5, quotedM: 430, actualM: 448, firstFix: true, readiness: 100, cause: null },
  { id: "JOB-2033", type: "TDT novo", date: "2026-08-10", quotedH: 3.5, actualH: 6.0, quotedM: 210, actualM: 297, firstFix: false, readiness: 78, cause: "Material em falta" },
  { id: "JOB-2031", type: "TDT reparação", date: "2026-08-07", quotedH: 1.5, actualH: 1.4, quotedM: 45, actualM: 45, firstFix: true, readiness: 100, cause: null },
  { id: "JOB-2030", type: "TDT reparação", date: "2026-08-05", quotedH: 2, actualH: 4.5, quotedM: 60, actualM: 138, firstFix: false, readiness: 71, cause: "Erro de orçamento" },
  { id: "JOB-2028", type: "MATV upgrade", date: "2026-08-01", quotedH: 8, actualH: 11.5, quotedM: 1100, actualM: 1310, firstFix: false, readiness: 85, cause: "Acesso / condições no local" },
  { id: "JOB-2026", type: "TDT novo", date: "2026-07-28", quotedH: 3.5, actualH: 3.2, quotedM: 210, actualM: 205, firstFix: true, readiness: 100, cause: null },
  { id: "JOB-2024", type: "SAT+TDT", date: "2026-07-24", quotedH: 5, actualH: 7.0, quotedM: 430, actualM: 512, firstFix: false, readiness: 82, cause: "Material em falta" },
  { id: "JOB-2022", type: "TDT novo", date: "2026-07-21", quotedH: 3.5, actualH: 3.6, quotedM: 210, actualM: 214, firstFix: true, readiness: 100, cause: null },
  { id: "JOB-2019", type: "MATV upgrade", date: "2026-07-16", quotedH: 8, actualH: 9.0, quotedM: 1100, actualM: 1145, firstFix: true, readiness: 96, cause: null },
  { id: "JOB-2017", type: "TDT reparação", date: "2026-07-12", quotedH: 2, actualH: 2.1, quotedM: 60, actualM: 60, firstFix: true, readiness: 100, cause: null },
  { id: "JOB-2015", type: "TDT novo", date: "2026-07-08", quotedH: 3.5, actualH: 5.5, quotedM: 210, actualM: 268, firstFix: false, readiness: 74, cause: "Sinal / infraestrutura externa" },
  { id: "JOB-2012", type: "SAT+TDT", date: "2026-07-03", quotedH: 5, actualH: 5.1, quotedM: 430, actualM: 436, firstFix: true, readiness: 100, cause: null },
];

/* Mar–Jun are historical; Jul/Ago are derived from HISTORY below. */
const FFR_TREND = [
  { m: "Mar", ffr: 62, target: 90 }, { m: "Abr", ffr: 66, target: 90 },
  { m: "Mai", ffr: 58, target: 90 }, { m: "Jun", ffr: 70, target: 90 },
  { m: "Jul", ffr: 71, target: 90 }, { m: "Ago", ffr: 40, target: 90 },
];

const CAUSES = [
  "Material em falta", "Erro de orçamento", "Acesso / condições no local",
  "Falha de equipamento", "Erro de instalação", "Alteração pedida pelo cliente",
  "Sinal / infraestrutura externa",
];

/* -------------------------- SMALL UTILS -------------------------- */

const eur = (n) => `€${n.toFixed(2)}`;
const pct = (n) => `${Math.round(n)}%`;

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

function openState(supplier, now = new Date()) {
  const slot = supplier.hours[now.getDay()];
  if (!slot) return { open: false, text: "Fechado hoje" };
  const cur = now.getHours() * 60 + now.getMinutes();
  const o = toMin(slot.open), c = toMin(slot.close);
  if (cur < o) return { open: false, text: `Abre às ${slot.open}` };
  if (cur >= c) return { open: false, text: `Fechou às ${slot.close}` };
  const left = c - cur;
  return { open: true, text: left <= 60 ? `Fecha em ${left} min` : `Aberto até ${slot.close}` };
}

const priceFor = (supplierId, itemId, prices) =>
  prices.find((p) => p.supplierId === supplierId && p.itemId === itemId);

function sourcingOptions(itemId, prices) {
  return prices
    .filter((p) => p.itemId === itemId)
    .map((p) => {
      const s = SUPPLIERS.find((x) => x.id === p.supplierId);
      return { ...p, supplier: s, state: openState(s) };
    })
    .sort((a, b) => a.price - b.price);
}

/* --------------------------- UI PIECES --------------------------- */

const CAT_META = {
  material: { label: "Material", icon: Package, color: "text-cyan-600", bg: "bg-cyan-50" },
  equipment: { label: "Equipamento", icon: Wrench, color: "text-zinc-500", bg: "bg-zinc-100" },
  doc: { label: "Documentação", icon: FileText, color: "text-amber-600", bg: "bg-amber-50" },
};

function Stat({ label, value, sub, tone = "zinc", icon: Icon, trend }) {
  const tones = {
    zinc: "border-zinc-200", green: "border-green-300", red: "border-red-300", amber: "border-amber-300",
  };
  return (
    <div className={`bg-white rounded border ${tones[tone]} p-4`}>
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</span>
        {Icon && <Icon className="w-4 h-4 text-zinc-400" />}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-mono font-semibold tabular-nums text-zinc-900">{value}</span>
        {trend && (
          <span className={`text-xs font-medium flex items-center gap-0.5 ${trend > 0 ? "text-green-600" : "text-red-600"}`}>
            {trend > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {Math.abs(trend)}pp
          </span>
        )}
      </div>
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

function Pill({ children, tone = "zinc" }) {
  const tones = {
    zinc: "bg-zinc-100 text-zinc-700", green: "bg-green-100 text-green-800",
    red: "bg-red-100 text-red-800", amber: "bg-amber-100 text-amber-800",
    cyan: "bg-cyan-100 text-cyan-800",
  };
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

function Section({ title, desc, right, children }) {
  return (
    <div className="bg-white rounded border border-zinc-200">
      <div className="px-4 py-3 border-b border-zinc-100 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
          {desc && <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>}
        </div>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

/* ============================ APP ============================ */

export default function FieldReady() {
  const [tab, setTab] = useState("dash");
  const [jobs, setJobs] = useState(JOBS);
  const [prices, setPrices] = useState(PRICES);
  const [openJobId, setOpenJobId] = useState(null);
  const [supplierId, setSupplierId] = useState("s1");
  const [toast, setToast] = useState(null);
  const [mode, setMode] = useState("office");

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3200); };

  const job = jobs.find((j) => j.id === openJobId);

  const nav = [
    { id: "dash", label: "Dashboard", icon: LayoutDashboard },
    { id: "jobs", label: "Trabalhos", icon: Briefcase },
    { id: "suppliers", label: "Fornecedores", icon: Store },
    { id: "notes", label: "Modelo", icon: Info },
  ];

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      {/* header */}
      <header className="bg-zinc-900 text-white">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Radio className="w-4 h-4 text-cyan-400" strokeWidth={2.5} />
            <span className="font-mono font-bold uppercase tracking-wider text-sm">FieldReady</span>
            <span className="text-xs text-zinc-500 font-mono hidden sm:inline">/ antenas &amp; telecom</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-zinc-300 hidden md:block">Antenas Rex, Lda · Lisboa</div>
            <div className="flex rounded-md overflow-hidden border border-zinc-700">
              {[["office", "Escritório", Briefcase], ["phone", "Técnico", Smartphone]].map(([m, l, I]) => (
                <button key={m} onClick={() => setMode(m)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs ${
                    mode === m ? "bg-cyan-500 text-white" : "text-zinc-400 hover:text-white"
                  }`}>
                  <I className="w-3.5 h-3.5" />{l}
                </button>
              ))}
            </div>
          </div>
        </div>
        <nav className={`max-w-6xl mx-auto px-4 flex gap-1 overflow-x-auto ${mode === "phone" ? "hidden" : ""}`}>
          {nav.map((n) => (
            <button key={n.id}
              onClick={() => { setTab(n.id); setOpenJobId(null); }}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 whitespace-nowrap ${
                tab === n.id ? "border-cyan-400 text-white" : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}>
              <n.icon className="w-4 h-4" />{n.label}
            </button>
          ))}
        </nav>
      </header>

      {mode === "phone" && <PhoneShell jobs={jobs} prices={prices} />}

      <main className={`max-w-6xl mx-auto px-4 py-5 ${mode === "phone" ? "hidden" : ""}`}>
        {tab === "dash" && <Dashboard jobs={jobs} prices={prices} onOpenJob={(id) => { setTab("jobs"); setOpenJobId(id); }} />}
        {tab === "jobs" && !job && <JobList jobs={jobs} onOpen={setOpenJobId} />}
        {tab === "jobs" && job && (
          <JobDetail
            job={job} prices={prices} onBack={() => setOpenJobId(null)}
            onUpdate={(next) => setJobs(jobs.map((j) => (j.id === next.id ? next : j)))}
            flash={flash}
          />
        )}
        {tab === "suppliers" && (
          <Suppliers
            prices={prices} setPrices={setPrices}
            selected={supplierId} setSelected={setSupplierId} flash={flash}
          />
        )}
        {tab === "notes" && <Notes />}
      </main>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-zinc-900 text-white border border-zinc-700 font-mono text-xs tracking-wide px-4 py-2 rounded">
          {toast}
        </div>
      )}
    </div>
  );
}

/* --------------------------- DASHBOARD --------------------------- */

function Dashboard({ jobs, prices, onOpenJob }) {
  const ffr = (HISTORY.filter((h) => h.firstFix).length / HISTORY.length) * 100;
  const timeVar = (HISTORY.reduce((a, h) => a + (h.actualH - h.quotedH) / h.quotedH, 0) / HISTORY.length) * 100;
  const matOver = HISTORY.reduce((a, h) => a + (h.actualM - h.quotedM), 0);
  const lostHours = HISTORY.reduce((a, h) => a + Math.max(0, h.actualH - h.quotedH), 0);

  /* the core insight: readiness score vs rework */
  const gated = HISTORY.filter((h) => h.readiness === 100);
  const ungated = HISTORY.filter((h) => h.readiness < 100);
  const reworkGated = (gated.filter((h) => !h.firstFix).length / gated.length) * 100;
  const reworkUngated = (ungated.filter((h) => !h.firstFix).length / ungated.length) * 100;

  const byType = useMemo(() => {
    const m = {};
    HISTORY.forEach((h) => {
      m[h.type] = m[h.type] || { type: h.type, q: 0, a: 0, n: 0 };
      m[h.type].q += h.quotedH; m[h.type].a += h.actualH; m[h.type].n++;
    });
    return Object.values(m).map((x) => ({
      type: x.type, variance: Math.round(((x.a - x.q) / x.q) * 100), n: x.n,
    })).sort((a, b) => b.variance - a.variance);
  }, []);

  const causeCounts = useMemo(() => {
    const m = {};
    HISTORY.filter((h) => h.cause).forEach((h) => { m[h.cause] = (m[h.cause] || 0) + 1; });
    return Object.entries(m).map(([cause, n]) => ({ cause, n })).sort((a, b) => b.n - a.n);
  }, []);

  const priceAlerts = useMemo(() => {
    return prices
      .filter((p) => p.prev && p.price > p.prev * 1.03)
      .map((p) => {
        const alt = sourcingOptions(p.itemId, prices).filter((o) => o.supplierId !== p.supplierId)[0];
        return {
          item: itemById(p.itemId), supplier: SUPPLIERS.find((s) => s.id === p.supplierId),
          price: p.price, prev: p.prev, delta: ((p.price - p.prev) / p.prev) * 100, alt,
        };
      })
      .sort((a, b) => b.delta - a.delta);
  }, [prices]);

  const blocked = jobs.filter((j) => j.checklist.some((c) => c.mandatory && c.status === "missing"));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="First-time fix" value={pct(ffr)} sub="Meta 90% · métrica principal"
          tone={ffr >= 90 ? "green" : ffr >= 75 ? "amber" : "red"}
          trend={FFR_TREND[5].ffr - FFR_TREND[4].ffr} icon={CheckCircle2} />
        <Stat label="Desvio de tempo" value={`+${Math.round(timeVar)}%`} sub={`${lostHours.toFixed(1)} h não orçamentadas`} tone="red" icon={Clock} />
        <Stat label="Derrapagem material" value={eur(matOver)} sub="12 trabalhos · últimos 45 dias" tone="red" icon={Package} />
        <Stat label="Trabalhos bloqueados" value={blocked.length} sub="readiness incompleto" tone={blocked.length ? "amber" : "green"} icon={AlertTriangle} />
      </div>

      {/* headline insight */}
      <div className="bg-white rounded border-l-4 border-l-red-500 border border-zinc-200 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold">
              Todos os retornos ao local vieram de trabalhos despachados com readiness incompleto
            </h3>
            <div className="mt-3 grid sm:grid-cols-2 gap-3">
              <div className="bg-green-50 rounded p-3">
                <div className="text-xs text-green-800 font-medium">Readiness 100% ({gated.length} trabalhos)</div>
                <div className="text-xl font-semibold text-green-900">{pct(reworkGated)}</div>
                <div className="text-xs text-green-700">taxa de retorno ao local</div>
              </div>
              <div className="bg-red-50 rounded p-3">
                <div className="text-xs text-red-800 font-medium">Readiness &lt; 100% ({ungated.length} trabalhos)</div>
                <div className="text-xl font-semibold text-red-900">{pct(reworkUngated)}</div>
                <div className="text-xs text-red-700">taxa de retorno ao local</div>
              </div>
            </div>
            <p className="mt-3 text-xs text-zinc-600">
              <span className="font-medium">Ação:</span> ativar o bloqueio obrigatório de despacho. Nos {ungated.length} trabalhos
              afetados isto teria evitado ~{ungated.reduce((a, h) => a + Math.max(0, h.actualH - h.quotedH), 0).toFixed(1)} h
              de deslocações repetidas.
            </p>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <Section title="Desvio de tempo por tipo de trabalho" desc="Real vs. orçamentado — corrige os orçamentos aqui">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={byType} layout="vertical" margin={{ left: 10, right: 30 }}>
              <XAxis type="number" tick={{ fontSize: 11 }} unit="%" />
              <YAxis type="category" dataKey="type" width={110} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => [`${v}%`, "desvio"]} />
              <Bar dataKey="variance" radius={[0, 4, 4, 0]}>
                {byType.map((d, i) => (
                  <Cell key={i} fill={d.variance > 25 ? "#dc2626" : d.variance > 10 ? "#f59e0b" : "#16a34a"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-zinc-500 mt-2">
            "TDT reparação" está +{byType.find((b) => b.type === "TDT reparação")?.variance}% acima do orçamento.
            Rever o tempo-padrão de 2 h para 3 h.
          </p>
        </Section>

        <Section title="First-time fix — tendência" desc="Percentagem de trabalhos fechados sem segunda visita">
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={FFR_TREND}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" />
              <XAxis dataKey="m" tick={{ fontSize: 11 }} />
              <YAxis domain={[50, 100]} tick={{ fontSize: 11 }} unit="%" />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="ffr" name="Real" stroke="#0891b2" strokeWidth={2} />
              <Line type="monotone" dataKey="target" name="Meta" stroke="#a1a1aa" strokeDasharray="4 4" strokeWidth={1} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Section>

        <Section title="Causas-raiz de retrabalho" desc="Registadas nos after-action reports">
          <div className="space-y-2">
            {causeCounts.map((c) => (
              <div key={c.cause} className="flex items-center gap-3">
                <div className="w-40 text-xs text-zinc-700 shrink-0">{c.cause}</div>
                <div className="flex-1 bg-zinc-100 rounded h-5 overflow-hidden">
                  <div className="bg-zinc-700 h-full" style={{ width: `${(c.n / causeCounts[0].n) * 100}%` }} />
                </div>
                <div className="w-6 text-xs text-zinc-600 text-right">{c.n}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-zinc-500 mt-3">
            "Material em falta" é 40% das causas e é 100% evitável pelo readiness gate.
          </p>
        </Section>

        <Section title="Alertas de preço" desc="Subidas detetadas nos recibos digitalizados">
          <div className="space-y-3">
            {priceAlerts.slice(0, 4).map((a, i) => (
              <div key={i} className="border border-zinc-200 rounded p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{a.item.name}</div>
                    <div className="text-xs text-zinc-500">{a.supplier.name}</div>
                  </div>
                  <Pill tone="red">+{a.delta.toFixed(1)}%</Pill>
                </div>
                <div className="mt-1.5 text-xs text-zinc-600">
                  {eur(a.prev)} → <span className="font-medium text-zinc-900">{eur(a.price)}</span>
                  {a.alt && a.alt.price < a.price && (
                    <span className="text-green-700"> · {a.alt.supplier.name.split("—")[0].trim()} tem a {eur(a.alt.price)} (poupa {eur(a.price - a.alt.price)})</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <Section title="Ações recomendadas" desc="Gerado a partir dos dados acima">
        <div className="space-y-2">
          {[
            { p: "Alta", t: "Ativar bloqueio de despacho com readiness < 100%", w: `${ungated.length} dos ${HISTORY.length} trabalhos foram despachados incompletos; ${ungated.filter((h) => !h.firstFix).length} falharam o first-time fix.` },
            { p: "Alta", t: `Rever tempo-padrão de "TDT reparação" 2 h → 3 h`, w: `Desvio médio de +${byType.find((b) => b.type === "TDT reparação")?.variance}%. Cada trabalho perde ~1 h de margem.` },
            { p: "Média", t: "Passar antena DAT BOSS LR para Casa das Antenas", w: `Rexel subiu para €78.40; Casa das Antenas está a €74.50. ~€3.90/un.` },
            { p: "Média", t: "Adicionar 1 rolo T100 e 2 fontes 24V ao stock da carrinha", w: "Itens em falta em 3 dos últimos 6 trabalhos de instalação nova." },
            { p: "Baixa", t: "Sincronizar horários dos fornecedores semanalmente", w: "Dados do Google expiram; a rota de recolha depende de horários corretos." },
          ].map((a, i) => (
            <div key={i} className="flex items-start gap-3 p-2.5 border border-zinc-200 rounded">
              <Pill tone={a.p === "Alta" ? "red" : a.p === "Média" ? "amber" : "zinc"}>{a.p}</Pill>
              <div className="min-w-0">
                <div className="text-sm font-medium">{a.t}</div>
                <div className="text-xs text-zinc-500 mt-0.5">{a.w}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {blocked.length > 0 && (
        <Section title="A precisar de atenção antes do despacho">
          {blocked.map((b) => (
            <button key={b.id} onClick={() => onOpenJob(b.id)}
              className="w-full flex items-center justify-between p-2.5 border border-amber-200 bg-amber-50 rounded hover:bg-amber-100 text-left">
              <div>
                <div className="text-sm font-medium">{b.id} · {b.title}</div>
                <div className="text-xs text-zinc-600">{b.scheduled} · {b.checklist.filter((c) => c.status === "missing").length} itens em falta</div>
              </div>
              <ArrowRight className="w-4 h-4 text-zinc-500" />
            </button>
          ))}
        </Section>
      )}
    </div>
  );
}

/* ---------------------------- JOB LIST --------------------------- */

function readiness(job) {
  const req = job.checklist.filter((c) => c.mandatory);
  const ok = req.filter((c) => c.status === "ok").length;
  return { ok, total: req.length, score: (ok / req.length) * 100, cleared: ok === req.length };
}

function JobList({ jobs, onOpen }) {
  return (
    <div className="space-y-5">
      <Section title="Trabalhos ativos" desc="Cada trabalho passa por: Readiness → Execução → After-action report">
        <div className="space-y-3">
          {jobs.map((j) => {
            const r = readiness(j);
            return (
              <button key={j.id} onClick={() => onOpen(j.id)}
                className="w-full text-left border border-zinc-200 rounded p-3 hover:border-zinc-400">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-zinc-500">{j.id}</span>
                      <Pill tone={j.status === "in-progress" ? "cyan" : "zinc"}>
                        {j.status === "in-progress" ? "Em curso" : "Pré-despacho"}
                      </Pill>
                    </div>
                    <div className="text-sm font-medium mt-1">{j.title}</div>
                    <div className="text-xs text-zinc-500 flex items-center gap-1 mt-0.5">
                      <MapPin className="w-3 h-3" />{j.address}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {j.scheduled} · {j.tech} · orçamento {j.quotedHours} h / {eur(j.quotedMaterials)}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-lg font-mono font-semibold tabular-nums ${r.cleared ? "text-green-600" : "text-amber-600"}`}>{pct(r.score)}</div>
                    <div className="text-xs text-zinc-500">readiness</div>
                  </div>
                </div>
                <div className="mt-2 h-1.5 bg-zinc-100 rounded overflow-hidden">
                  <div className={`h-full ${r.cleared ? "bg-green-500" : "bg-amber-500"}`} style={{ width: `${r.score}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Histórico" desc="Base de dados para orçamentos futuros e análise de causas">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-200">
                <th className="py-1.5 pr-3">Trabalho</th><th className="pr-3">Tipo</th><th className="pr-3">Data</th>
                <th className="pr-3">Horas</th><th className="pr-3">Material</th>
                <th className="pr-3">Readiness</th><th className="pr-3">1ª visita</th><th>Causa</th>
              </tr>
            </thead>
            <tbody>
              {HISTORY.map((h) => (
                <tr key={h.id} className="border-b border-zinc-100">
                  <td className="py-1.5 pr-3 font-mono text-zinc-600">{h.id}</td>
                  <td className="pr-3">{h.type}</td>
                  <td className="pr-3 text-zinc-500">{h.date}</td>
                  <td className={`pr-3 ${h.actualH > h.quotedH * 1.1 ? "text-red-600 font-medium" : ""}`}>
                    {h.actualH} / {h.quotedH}
                  </td>
                  <td className={`pr-3 ${h.actualM > h.quotedM * 1.05 ? "text-red-600 font-medium" : ""}`}>
                    {eur(h.actualM)}
                  </td>
                  <td className={`pr-3 ${h.readiness < 100 ? "text-amber-600 font-medium" : "text-green-600"}`}>{h.readiness}%</td>
                  <td className="pr-3">{h.firstFix ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <XCircle className="w-3.5 h-3.5 text-red-500" />}</td>
                  <td className="text-zinc-600">{h.cause || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

/* --------------------------- JOB DETAIL -------------------------- */

function JobDetail({ job, prices, onBack, onUpdate, flash }) {
  const [stage, setStage] = useState(job.status === "in-progress" ? "aar" : "ready");
  const r = readiness(job);

  const setItem = (id, status) =>
    onUpdate({ ...job, checklist: job.checklist.map((c) => (c.id === id ? { ...c, status } : c)) });

  const missing = job.checklist.filter((c) => c.status === "missing");
  const missingMaterials = missing.filter((c) => c.cat === "material" && c.itemId);

  /* pickup run: cheapest open supplier that covers the most missing items */
  const pickupPlan = useMemo(() => {
    const bySupplier = {};
    missingMaterials.forEach((m) => {
      sourcingOptions(m.itemId, prices).forEach((o) => {
        bySupplier[o.supplierId] = bySupplier[o.supplierId] || { supplier: o.supplier, state: o.state, items: [], total: 0 };
        bySupplier[o.supplierId].items.push({ line: m, price: o.price });
        bySupplier[o.supplierId].total += o.price * m.qty;
      });
    });
    return Object.values(bySupplier).sort((a, b) => {
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      if (a.state.open !== b.state.open) return a.state.open ? -1 : 1;
      return a.total - b.total;
    });
  }, [missingMaterials, prices]);

  return (
    <div className="space-y-5">
      <button onClick={onBack} className="text-xs text-zinc-500 hover:text-zinc-900">← Trabalhos</button>

      <div className="bg-white rounded border border-zinc-200 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-mono text-zinc-500">{job.id}</div>
            <h2 className="text-lg font-semibold">{job.title}</h2>
            <div className="text-xs text-zinc-500 mt-1">{job.client} · {job.address}</div>
            <div className="text-xs text-zinc-500">{job.scheduled} · {job.tech} · {job.type}</div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xs text-zinc-500">Orçamentado</div>
            <div className="text-sm font-medium">{job.quotedHours} h · {eur(job.quotedMaterials)}</div>
          </div>
        </div>

        <div className="mt-4 flex gap-1 border-b border-zinc-200">
          {[["ready", "1 · Readiness"], ["exec", "2 · Execução"], ["aar", "3 · After-action report"]].map(([id, label]) => (
            <button key={id} onClick={() => setStage(id)}
              className={`px-3 py-1.5 text-xs border-b-2 -mb-px ${
                stage === id ? "border-cyan-600 text-cyan-700 font-medium" : "border-transparent text-zinc-500 hover:text-zinc-800"
              }`}>{label}</button>
          ))}
        </div>
      </div>

      {stage === "ready" && (
        <>
          <div className={`rounded border p-4 ${r.cleared ? "bg-green-50 border-green-300" : "bg-amber-50 border-amber-300"}`}>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                {r.cleared ? <CheckCircle2 className="w-6 h-6 text-green-600" /> : <AlertTriangle className="w-6 h-6 text-amber-600" />}
                <div>
                  <div className="text-sm font-semibold">
                    {r.cleared ? "Pronto para despacho" : `Despacho bloqueado — ${missing.filter((m) => m.mandatory).length} itens obrigatórios em falta`}
                  </div>
                  <div className="text-xs text-zinc-600">{r.ok} de {r.total} verificações obrigatórias · {pct(r.score)}</div>
                </div>
              </div>
              <button disabled={!r.cleared}
                onClick={() => { flash("Trabalho despachado — cronómetro iniciado"); setStage("exec"); }}
                className={`px-4 py-2 rounded text-sm font-medium ${
                  r.cleared ? "bg-green-600 text-white hover:bg-green-700" : "bg-zinc-200 text-zinc-400 cursor-not-allowed"
                }`}>
                Despachar trabalho
              </button>
            </div>
          </div>

          {[
            ["job", "Lista do técnico", "É só isto que aparece no telemóvel. Manter entre 4 e 6 itens."],
            ["van", "Stock da carrinha", `Auditoria semanal — última ${VAN_AUDIT.date} por ${VAN_AUDIT.by} · próxima ${VAN_AUDIT.nextDue}`],
            ["office", "Verificado pelo escritório", "Automático. O técnico nunca vê estes itens."],
          ].map(([scope, title, desc]) => {
            const rows = job.checklist.filter((c) => c.scope === scope);
            if (!rows.length) return null;
            const done = rows.filter((c) => c.status === "ok").length;
            return (
              <Section key={scope} title={title} desc={desc}
                right={<Pill tone={done === rows.length ? "green" : "amber"}>{done}/{rows.length}</Pill>}>
                <div className="space-y-1.5">
                  {rows.map((c) => {
                    const src = c.itemId ? sourcingOptions(c.itemId, prices)[0] : null;
                    const CatIcon = CAT_META[c.cat].icon;
                    return (
                      <div key={c.id} className={`flex items-center gap-3 p-2 rounded border ${
                        c.status === "ok" ? "border-zinc-100" : "border-red-200 bg-red-50"
                      }`}>
                        <button onClick={() => setItem(c.id, c.status === "ok" ? "missing" : "ok")}
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                            c.status === "ok" ? "bg-green-600 border-green-600" : "border-zinc-300 bg-white"
                          }`}>
                          {c.status === "ok" && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
                        </button>
                        <CatIcon className={`w-4 h-4 shrink-0 ${CAT_META[c.cat].color}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm flex items-center gap-2">
                            <span className={c.status === "ok" ? "text-zinc-700" : "font-medium"}>{c.label}</span>
                            {!c.mandatory && <Pill>opcional</Pill>}
                          </div>
                          {c.status === "missing" && src && (
                            <div className="text-xs text-zinc-600 mt-0.5">
                              {src.supplier.name.split("—")[0].trim()} · {eur(src.price)} ·{" "}
                              <span className={src.state.open ? "text-green-700" : "text-red-600"}>{src.state.text}</span> · {src.supplier.distanceKm} km
                            </div>
                          )}
                        </div>
                        <div className="text-xs text-zinc-500 shrink-0">×{c.qty}</div>
                      </div>
                    );
                  })}
                </div>
              </Section>
            );
          })}

          {missingMaterials.length > 0 && (
            <Section title="Rota de recolha sugerida"
              desc="Combina preço histórico, distância e horário do fornecedor (dados Google Places)">
              <div className="space-y-3">
                {pickupPlan.slice(0, 3).map((p, i) => (
                  <div key={p.supplier.id} className={`border rounded p-3 ${i === 0 ? "border-cyan-400 bg-cyan-50" : "border-zinc-200"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium flex items-center gap-2">
                          {p.supplier.name}
                          {i === 0 && <Pill tone="cyan">recomendado</Pill>}
                        </div>
                        <div className="text-xs text-zinc-600 mt-0.5 flex items-center gap-2 flex-wrap">
                          <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{p.supplier.distanceKm} km</span>
                          <span className={p.state.open ? "text-green-700 font-medium" : "text-red-600 font-medium"}>{p.state.text}</span>
                          <span>{p.items.length} de {missingMaterials.length} itens</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-semibold">{eur(p.total)}</div>
                        <div className="text-xs text-zinc-500">estimado</div>
                      </div>
                    </div>
                    <div className="mt-2 pt-2 border-t border-zinc-200 space-y-0.5">
                      {p.items.map((it, k) => (
                        <div key={k} className="flex justify-between text-xs text-zinc-600">
                          <span>{it.line.qty}× {itemById(it.line.itemId).name}</span>
                          <span>{eur(it.price * it.line.qty)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
                {pickupPlan.length > 1 && pickupPlan[0].items.length < missingMaterials.length && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                    Nenhum fornecedor cobre tudo. Serão precisas {Math.min(2, pickupPlan.length)} paragens —
                    acrescente ~40 min ao trabalho ou reagende.
                  </p>
                )}
              </div>
            </Section>
          )}
        </>
      )}

      {stage === "exec" && <Execution job={job} />}
      {stage === "aar" && <AAR job={job} flash={flash} />}
    </div>
  );
}

/* --------------------------- EXECUTION --------------------------- */

function Execution({ job }) {
  const steps = [
    "Confirmar local de instalação e ponto de fixação com o cliente",
    "Fotografar estado inicial (telhado, quadro, tomadas existentes)",
    "Montar mastro e fixações — verificar aperto e verticalidade",
    "Orientar antena e otimizar com medidor de campo",
    "Passar e fixar cabo coaxial — raio de curvatura ≥ 10× Ø",
    "Crimpar fichas F e testar continuidade",
    "Instalar amplificador e fonte de alimentação",
    "Medir em cada tomada e registar valores",
    "Limpar o local e remover material antigo",
  ];
  const [done, setDone] = useState([0, 1, 2]);
  const toggle = (i) => setDone(done.includes(i) ? done.filter((x) => x !== i) : [...done, i]);

  return (
    <>
      <div className="bg-cyan-50 border border-cyan-200 rounded p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Clock className="w-5 h-5 text-cyan-600" />
          <div>
            <div className="text-sm font-semibold">Cronómetro a correr — 2 h 14 min</div>
            <div className="text-xs text-zinc-600">Orçamentado {job.quotedHours} h · restam {(job.quotedHours - 2.23).toFixed(1)} h antes de derrapar</div>
          </div>
        </div>
        <div className="text-2xl font-mono font-semibold tabular-nums text-cyan-700">{pct((2.23 / job.quotedHours) * 100)}</div>
      </div>

      <Section title="Passos de execução" desc={`${done.length} de ${steps.length} concluídos`}>
        <div className="space-y-1.5">
          {steps.map((s, i) => (
            <button key={i} onClick={() => toggle(i)}
              className="w-full flex items-center gap-3 p-2 rounded hover:bg-zinc-50 text-left">
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                done.includes(i) ? "bg-cyan-600 border-cyan-600" : "border-zinc-300"
              }`}>
                {done.includes(i) && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
              </div>
              <span className={`text-sm ${done.includes(i) ? "text-zinc-400 line-through" : "text-zinc-800"}`}>{s}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Registo fotográfico" desc="Antes / durante / depois — obrigatório para fecho">
        <div className="grid grid-cols-3 gap-2">
          {["Antes", "Durante", "Depois"].map((l) => (
            <div key={l} className="border-2 border-dashed border-zinc-300 rounded p-6 text-center">
              <Camera className="w-5 h-5 text-zinc-400 mx-auto" />
              <div className="text-xs text-zinc-500 mt-1">{l}</div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

/* ------------------------------ AAR ------------------------------ */

function AAR({ job, flash }) {
  const [outlets, setOutlets] = useState([
    { name: "Sala", vals: { t1: "58", t2: "27" } },
    { name: "Quarto 1", vals: { t1: "54", t2: "24" } },
    { name: "Quarto 2", vals: { t1: "41", t2: "19" } },
  ]);
  const [actualH, setActualH] = useState("5.5");
  const [cause, setCause] = useState("Acesso / condições no local");
  const [firstFix, setFirstFix] = useState("no");
  const [notes, setNotes] = useState(
    "Tomada do Quarto 2 alimentada por cabo antigo de 75Ω degradado, não previsto no orçamento. " +
    "Sinal aceitável na sala e quarto 1. Cliente informado; proposta de substituição do troço enviada."
  );

  const setVal = (i, tid, v) =>
    setOutlets(outlets.map((o, k) => (k === i ? { ...o, vals: { ...o.vals, [tid]: v } } : o)));

  const results = outlets.map((o) => ({
    name: o.name,
    tests: TDT_TESTS.map((t) => ({ t, v: o.vals[t.id], r: evalTest(t, o.vals[t.id]) })),
  }));
  const failed = results.filter((o) => o.tests.some((x) => x.r === "fail"));
  const allPass = failed.length === 0;

  const varH = ((Number(actualH) - job.quotedHours) / job.quotedHours) * 100;

  return (
    <>
      <Section title="Testes de aceitação — DVB-T2" desc="Medido em cada tomada. Pass/fail automático contra o limiar.">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-200">
                <th className="py-1.5 pr-2">Tomada</th>
                {TDT_TESTS.map((t) => (
                  <th key={t.id} className="pr-2 font-normal">
                    <div className="font-medium text-zinc-700">{t.label}</div>
                    <div className="text-zinc-400">{threshLabel(t)}</div>
                  </th>
                ))}
                <th>Resultado</th>
              </tr>
            </thead>
            <tbody>
              {results.map((o, i) => {
                const ok = o.tests.every((x) => x.r === "pass");
                return (
                  <tr key={i} className="border-b border-zinc-100">
                    <td className="py-2 pr-2 font-medium">{o.name}</td>
                    {o.tests.map((x, k) => (
                      <td key={k} className="pr-2 py-1">
                        <input value={x.v} onChange={(e) => setVal(i, x.t.id, e.target.value)}
                          className={`w-20 px-1.5 py-1 rounded border font-mono tabular-nums text-xs ${
                            x.r === "fail" ? "border-red-400 bg-red-50 text-red-800 font-medium"
                              : x.r === "pass" ? "border-green-300 bg-green-50 text-green-800"
                                : "border-zinc-300"
                          }`} />
                      </td>
                    ))}
                    <td>{ok ? <Pill tone="green">Conforme</Pill> : <Pill tone="red">Não conforme</Pill>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className={`mt-3 p-2.5 rounded text-xs ${allPass ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
          {allPass
            ? "Todas as tomadas conformes — pode emitir a declaração de conformidade."
            : `${failed.length} tomada(s) fora de especificação: ${failed.map((f) => f.name).join(", ")}. Declaração de conformidade bloqueada até resolução ou ressalva assinada pelo cliente.`}
        </div>
        <p className="text-xs text-zinc-400 mt-2">
          Limiares são valores por defeito e devem ser confirmados contra a sua especificação de aceitação e o emissor que serve o local.
        </p>
      </Section>

      <div className="grid md:grid-cols-2 gap-5">
        <Section title="Tempo e custo" desc="Alimenta diretamente os orçamentos futuros">
          <div className="space-y-3">
            <div>
              <label className="text-xs text-zinc-500">Horas reais</label>
              <div className="flex items-center gap-2 mt-1">
                <input value={actualH} onChange={(e) => setActualH(e.target.value)}
                  className="w-24 px-2 py-1.5 border border-zinc-300 rounded text-sm" />
                <span className="text-xs text-zinc-500">vs {job.quotedHours} h orçamentadas</span>
                {!isNaN(varH) && (
                  <Pill tone={varH > 10 ? "red" : varH < -5 ? "green" : "zinc"}>
                    {varH > 0 ? "+" : ""}{varH.toFixed(0)}%
                  </Pill>
                )}
              </div>
            </div>
            <div className="text-xs space-y-1 pt-2 border-t border-zinc-100">
              <div className="flex justify-between"><span className="text-zinc-500">Material orçamentado</span><span>{eur(job.quotedMaterials)}</span></div>
              <div className="flex justify-between"><span className="text-zinc-500">Material consumido</span><span className="font-medium">{eur(job.quotedMaterials * 1.11)}</span></div>
              <div className="flex justify-between text-red-600"><span>Derrapagem</span><span className="font-medium">{eur(job.quotedMaterials * 0.11)}</span></div>
            </div>
            {varH > 10 && (
              <div className="text-xs bg-amber-50 border border-amber-200 rounded p-2 text-amber-800">
                Este tipo de trabalho está sistematicamente subestimado. Sugestão: subir o tempo-padrão
                de {job.quotedHours} h para {(Number(actualH)).toFixed(1)} h nos próximos orçamentos.
              </div>
            )}
          </div>
        </Section>

        <Section title="Resultado e causa-raiz" desc="Taxonomia fixa — é isto que torna o histórico analisável">
          <div className="space-y-3">
            <div>
              <label className="text-xs text-zinc-500">Resolvido à primeira visita?</label>
              <div className="flex gap-2 mt-1">
                {[["yes", "Sim"], ["no", "Não — requer retorno"]].map(([v, l]) => (
                  <button key={v} onClick={() => setFirstFix(v)}
                    className={`px-3 py-1.5 rounded text-xs border ${
                      firstFix === v ? "bg-zinc-900 text-white border-zinc-900" : "border-zinc-300 text-zinc-600"
                    }`}>{l}</button>
                ))}
              </div>
            </div>
            {firstFix === "no" && (
              <div>
                <label className="text-xs text-zinc-500">Causa-raiz</label>
                <select value={cause} onChange={(e) => setCause(e.target.value)}
                  className="w-full mt-1 px-2 py-1.5 border border-zinc-300 rounded text-sm bg-white">
                  {CAUSES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="text-xs text-zinc-500">Observações</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4}
                className="w-full mt-1 px-2 py-1.5 border border-zinc-300 rounded text-xs" />
            </div>
          </div>
        </Section>
      </div>

      <Section title="Ações de seguimento" desc="Criadas a partir do que correu mal — não ficam num PDF">
        <div className="space-y-2">
          {[
            { t: "Orçamentar substituição do troço de cabo do Quarto 2", who: "Escritório", when: "18/08" },
            { t: "Adicionar 'verificar cablagem existente' ao levantamento pré-orçamento", who: "Processo", when: "Esta semana" },
            { t: "Repor stock: 1 rolo T100, 2 fontes 24V", who: "Compras", when: "Antes do próximo trabalho" },
          ].map((a, i) => (
            <div key={i} className="flex items-center justify-between p-2 border border-zinc-200 rounded">
              <span className="text-sm">{a.t}</span>
              <span className="text-xs text-zinc-500 shrink-0 ml-3">{a.who} · {a.when}</span>
            </div>
          ))}
        </div>
      </Section>

      <div className="bg-white rounded border border-zinc-200 p-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <PenTool className="w-5 h-5 text-zinc-400" />
          <div>
            <div className="text-sm font-medium">Assinatura do cliente</div>
            <div className="text-xs text-zinc-500">Confirma o trabalho realizado e as ressalvas registadas</div>
          </div>
        </div>
        <button onClick={() => flash("AAR fechado · histórico e dashboard atualizados · faturação enviada para o Moloni")}
          className="px-4 py-2 bg-zinc-900 text-white rounded text-sm font-medium hover:bg-zinc-800">
          Fechar trabalho
        </button>
      </div>
    </>
  );
}

/* --------------------------- SUPPLIERS --------------------------- */

const FAKE_RECEIPT = {
  supplierId: "s1", doc: "FT 2026/15104", date: "2026-08-17",
  lines: [
    { itemId: "i3", desc: "CABO COAX T100 CL.A 100M", qty: 2, price: 60.5 },
    { itemId: "i7", desc: "FONTE ALIM 24V MASTRO", qty: 2, price: 18.6 },
    { itemId: "i1", desc: "ANTENA DAT BOSS LR TELEVES", qty: 1, price: 76.9 },
    { itemId: null, desc: "PORTES DE ENVIO", qty: 1, price: 8.5 },
  ],
};

function Suppliers({ prices, setPrices, selected, setSelected, flash }) {
  const [scan, setScan] = useState(null);
  const s = SUPPLIERS.find((x) => x.id === selected);
  const state = openState(s);
  const rows = prices.filter((p) => p.supplierId === s.id);

  const applyReceipt = () => {
    let next = [...prices];
    scan.lines.filter((l) => l.itemId).forEach((l) => {
      const idx = next.findIndex((p) => p.supplierId === scan.supplierId && p.itemId === l.itemId);
      if (idx >= 0) next[idx] = { ...next[idx], prev: next[idx].price, price: l.price, src: "receipt", date: scan.date, doc: scan.doc };
      else next.push({ supplierId: scan.supplierId, itemId: l.itemId, price: l.price, prev: null, src: "receipt", date: scan.date, doc: scan.doc });
    });
    setPrices(next);
    setScan(null);
    flash("Preços atualizados a partir do recibo · 3 artigos");
  };

  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {SUPPLIERS.map((sup) => {
          const st = openState(sup);
          return (
            <button key={sup.id} onClick={() => setSelected(sup.id)}
              className={`text-left p-3 rounded border ${
                selected === sup.id ? "border-zinc-900 bg-white" : "border-zinc-200 bg-white hover:border-zinc-400"
              }`}>
              <div className="text-sm font-medium leading-tight">{sup.name}</div>
              <div className="text-xs text-zinc-500 mt-1">{sup.category}</div>
              <div className="mt-2 flex items-center justify-between">
                <Pill tone={st.open ? "green" : "red"}>{st.open ? "Aberto" : "Fechado"}</Pill>
                <span className="text-xs text-zinc-500">{sup.distanceKm} km</span>
              </div>
            </button>
          );
        })}
      </div>

      <Section title={s.name} desc={s.category}
        right={<Pill tone={state.open ? "green" : "red"}>{state.text}</Pill>}>
        <div className="grid md:grid-cols-2 gap-4 text-xs">
          <div className="space-y-1.5">
            <div className="flex gap-2"><MapPin className="w-3.5 h-3.5 text-zinc-400 shrink-0 mt-0.5" /><span>{s.address}</span></div>
            <div className="text-zinc-500">{s.phone} · {s.distanceKm} km da base</div>
            <div className="text-zinc-500">{s.account}</div>
            <div className="text-zinc-400 pt-1">
              Morada e horário sincronizados do Google Places · place_id <code className="text-zinc-500">{s.placeId}</code> · {s.syncedAt}
            </div>
          </div>
          <div>
            <div className="font-medium text-zinc-700 mb-1">Horário</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
              {["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"].map((d, i) => (
                <div key={d} className="flex justify-between">
                  <span className="text-zinc-500">{d}</span>
                  <span>{s.hours[i] ? `${s.hours[i].open}–${s.hours[i].close}` : "Fechado"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section title="Tabela de preços" desc="Atualizada por digitalização de recibo ou manualmente"
        right={
          <button onClick={() => setScan(FAKE_RECEIPT)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 text-white rounded text-xs font-medium hover:bg-zinc-800">
            <Receipt className="w-3.5 h-3.5" />Digitalizar recibo
          </button>
        }>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-200">
              <th className="py-1.5 pr-2">Artigo</th><th className="pr-2">SKU</th>
              <th className="pr-2">Preço</th><th className="pr-2">Variação</th>
              <th className="pr-2">Origem</th><th>Atualizado</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => {
              const it = itemById(p.itemId);
              const d = p.prev ? ((p.price - p.prev) / p.prev) * 100 : 0;
              const stale = new Date(p.date) < new Date("2026-07-01");
              return (
                <tr key={i} className="border-b border-zinc-100">
                  <td className="py-1.5 pr-2">{it.name}</td>
                  <td className="pr-2 font-mono text-zinc-500">{it.sku}</td>
                  <td className="pr-2 font-mono tabular-nums font-medium">{eur(p.price)}</td>
                  <td className="pr-2 font-mono tabular-nums">
                    {d === 0 ? <span className="text-zinc-400">—</span>
                      : <span className={d > 0 ? "text-red-600" : "text-green-600"}>{d > 0 ? "+" : ""}{d.toFixed(1)}%</span>}
                  </td>
                  <td className="pr-2">
                    <Pill tone={p.src === "receipt" ? "cyan" : "zinc"}>{p.src === "receipt" ? "recibo" : "manual"}</Pill>
                  </td>
                  <td className={stale ? "text-amber-600" : "text-zinc-500"}>
                    {p.date}{stale && " · desatualizado"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section title="Comparação entre fornecedores" desc="Melhor preço conhecido por artigo">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-zinc-500 border-b border-zinc-200">
              <th className="py-1.5 pr-2">Artigo</th>
              {SUPPLIERS.map((sup) => <th key={sup.id} className="pr-2">{sup.name.split("—")[0].trim()}</th>)}
            </tr>
          </thead>
          <tbody>
            {CATALOG.map((it) => {
              const opts = prices.filter((p) => p.itemId === it.id);
              if (!opts.length) return null;
              const best = Math.min(...opts.map((o) => o.price));
              return (
                <tr key={it.id} className="border-b border-zinc-100">
                  <td className="py-1.5 pr-2">{it.name}</td>
                  {SUPPLIERS.map((sup) => {
                    const p = priceFor(sup.id, it.id, prices);
                    return (
                      <td key={sup.id} className="pr-2 font-mono tabular-nums">
                        {p ? (
                          <span className={p.price === best ? "text-green-700 font-semibold" : "text-zinc-600"}>
                            {eur(p.price)}
                          </span>
                        ) : <span className="text-zinc-300">—</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      {scan && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded max-w-lg w-full max-h-full overflow-auto">
            <div className="px-4 py-3 border-b border-zinc-200">
              <h3 className="text-sm font-semibold flex items-center gap-2"><Receipt className="w-4 h-4" />Recibo lido</h3>
              <p className="text-xs text-zinc-500 mt-0.5">
                {SUPPLIERS.find((x) => x.id === scan.supplierId).name} · {scan.doc} · {scan.date}
              </p>
            </div>
            <div className="p-4 space-y-2">
              <p className="text-xs text-zinc-500">Confirme a correspondência antes de atualizar a tabela de preços.</p>
              {scan.lines.map((l, i) => {
                const cur = l.itemId ? priceFor(scan.supplierId, l.itemId, prices) : null;
                const d = cur ? ((l.price - cur.price) / cur.price) * 100 : null;
                return (
                  <div key={i} className={`border rounded p-2.5 ${l.itemId ? "border-zinc-200" : "border-zinc-100 bg-zinc-50"}`}>
                    <div className="flex justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-mono text-zinc-500 truncate">{l.desc}</div>
                        <div className="text-sm">
                          {l.itemId ? itemById(l.itemId).name : <span className="text-zinc-400">sem correspondência — ignorar</span>}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-medium">{eur(l.price)}</div>
                        <div className="text-xs text-zinc-500">×{l.qty}</div>
                      </div>
                    </div>
                    {cur && (
                      <div className="text-xs mt-1 pt-1 border-t border-zinc-100">
                        atual {eur(cur.price)} →{" "}
                        <span className={d > 0 ? "text-red-600 font-medium" : d < 0 ? "text-green-600 font-medium" : "text-zinc-500"}>
                          {eur(l.price)} ({d > 0 ? "+" : ""}{d.toFixed(1)}%)
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="px-4 py-3 border-t border-zinc-200 flex justify-end gap-2">
              <button onClick={() => setScan(null)} className="px-3 py-1.5 text-sm text-zinc-600 hover:text-zinc-900">Cancelar</button>
              <button onClick={applyReceipt} className="px-3 py-1.5 bg-zinc-900 text-white rounded text-sm font-medium">
                Atualizar 3 preços
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ========================= TECHNICIAN PHONE ========================
   Design rules applied throughout:
   · one decision per screen, never a list to parse
   · every tap target ≥ 56px (gloves)
   · pass/fail carries icon + word + colour, never colour alone
   · zero required typing — photo-OCR and voice first, manual as fallback
   · the technician never classifies anything; the office does
   ================================================================== */

const OUTLETS = ["Sala", "Quarto 1", "Quarto 2"];
/* t1 = nível de sinal (dBµV), t2 = MER (dB) — Tabela 6.12, TT/tomada test.
   Real ITED structure has only these two per-outlet parameters; see
   TDT_TESTS above for the correction note. */
const METER_READS = {
  "Sala": { t1: "58", t2: "27" },
  "Quarto 1": { t1: "54", t2: "24" },
  "Quarto 2": { t1: "41", t2: "19" },
};

const ITEM_TINT = {
  material: "bg-cyan-100 text-cyan-700",
  equipment: "bg-zinc-200 text-zinc-600",
  doc: "bg-amber-100 text-amber-700",
};

function BigBtn({ children, onClick, tone = "dark", disabled, icon: Icon }) {
  const tones = {
    dark: "bg-zinc-900 text-white active:bg-zinc-700",
    green: "bg-green-600 text-white active:bg-green-700",
    red: "bg-red-600 text-white active:bg-red-700",
    ghost: "bg-white text-zinc-800 border-2 border-zinc-300 active:bg-zinc-100",
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`w-full py-4 px-4 rounded-xl text-lg font-semibold flex items-center justify-center gap-2 ${
        disabled ? "bg-zinc-200 text-zinc-400" : tones[tone]
      }`}>
      {Icon && <Icon className="w-6 h-6" />}{children}
    </button>
  );
}

function PhoneShell({ jobs, prices }) {
  const job = jobs.find((j) => j.id === "JOB-2041");
  const list = job.checklist.filter((c) => c.scope === "job");

  const [screen, setScreen] = useState("pin");
  const [pin, setPin] = useState("");
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});
  const [outletI, setOutletI] = useState(0);
  const [vals, setVals] = useState({});
  const [reading, setReading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState("");

  const answer = (id, v) => {
    setAnswers({ ...answers, [id]: v });
    if (idx + 1 < list.length) setIdx(idx + 1);
    else setScreen("prepresult");
  };

  const missing = list.filter((c) => answers[c.id] === "no");
  const missingMat = missing.filter((c) => c.itemId);

  const go = (s) => setScreen(s);

  /* ------------------------- screens ------------------------- */
  const screens = {
    pin: (
      <div className="flex flex-col h-full bg-zinc-900 text-white p-6">
        <div className="flex-1 flex flex-col items-center justify-center">
          <Radio className="w-10 h-10 text-cyan-400" />
          <div className="mt-3 text-lg font-semibold">Olá, Rui</div>
          <div className="text-sm text-zinc-400">Código de 4 dígitos</div>
          <div className="flex gap-3 mt-5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`w-4 h-4 rounded-full ${i < pin.length ? "bg-cyan-400" : "bg-zinc-700"}`} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, null, 0, "←"].map((n, i) => (
            <button key={i} disabled={n === null}
              onClick={() => {
                if (n === "←") return setPin(pin.slice(0, -1));
                const next = pin + n;
                setPin(next);
                if (next.length === 4) setTimeout(() => { setPin(""); go("home"); }, 200);
              }}
              className={`py-4 rounded-xl text-2xl font-medium ${n === null ? "" : "bg-zinc-800 active:bg-zinc-700"}`}>
              {n}
            </button>
          ))}
        </div>
        <p className="text-xs text-zinc-500 text-center mt-4">Sem palavra-passe. Telemóvel associado ao técnico.</p>
      </div>
    ),

    home: (
      <div className="flex flex-col h-full bg-zinc-50">
        <div className="bg-zinc-900 text-white px-5 py-4">
          <div className="text-xs text-zinc-400">Segunda, 17 de agosto</div>
          <div className="text-xl font-semibold">Bom dia, Rui</div>
        </div>
        <div className="p-4 space-y-3 flex-1 overflow-auto">
          <button onClick={() => go("van")}
            className="w-full flex items-center gap-3 p-4 rounded-xl bg-amber-100 border-2 border-amber-400 text-left">
            <Truck className="w-7 h-7 text-amber-700 shrink-0" />
            <div>
              <div className="font-semibold text-amber-900">Carrinha com {VAN_AUDIT.issues.length} falhas</div>
              <div className="text-sm text-amber-800">Toque para ver</div>
            </div>
          </button>

          <div className="text-xs font-semibold text-zinc-500 uppercase pt-2">Hoje</div>
          <div className="bg-white rounded-xl border-2 border-zinc-200 p-4">
            <div className="text-2xl font-bold">09:00</div>
            <div className="text-lg font-semibold mt-1 leading-tight">Antena TDT — moradia</div>
            <div className="text-base text-zinc-600 mt-1">{job.client}</div>
            <div className="text-base text-zinc-600">Campo de Ourique, Lisboa</div>
            <div className="mt-4 space-y-2">
              <BigBtn onClick={() => { setIdx(0); setAnswers({}); go("prep"); }} icon={Package}>
                Ver o que levar
              </BigBtn>
              <BigBtn tone="ghost" icon={Navigation}>Abrir mapa</BigBtn>
            </div>
          </div>
        </div>
      </div>
    ),

    van: (
      <PhonePage title="Carrinha 1" onBack={() => go("home")}>
        <p className="text-base text-zinc-600">
          Verificada {VAN_AUDIT.date}. Próxima verificação {VAN_AUDIT.nextDue}.
        </p>
        <div className="space-y-3 mt-4">
          {VAN_AUDIT.issues.map((it, i) => (
            <div key={i} className="flex gap-3 p-4 rounded-xl bg-red-50 border-2 border-red-300">
              <XCircle className="w-6 h-6 text-red-600 shrink-0" />
              <div>
                <div className="font-semibold text-red-900">{it.label}</div>
                <div className="text-sm text-red-800">{it.note}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="text-sm text-zinc-500 mt-4">
          O escritório já sabe. Nada a fazer aqui — verifique só se já foi resolvido.
        </p>
      </PhonePage>
    ),

    prep: (() => {
      const c = list[idx];
      const CatIcon = CAT_META[c.cat].icon;
      return (
        <div className="flex flex-col h-full bg-white">
          <div className="px-4 pt-4">
            <div className="flex items-center justify-between">
              <button onClick={() => (idx > 0 ? setIdx(idx - 1) : go("home"))} className="p-2 -ml-2">
                <ChevronLeft className="w-6 h-6 text-zinc-500" />
              </button>
              <div className="text-lg font-bold text-zinc-700">{idx + 1} de {list.length}</div>
            </div>
            <div className="mt-2 h-2 bg-zinc-200 rounded-full overflow-hidden">
              <div className="h-full bg-cyan-600" style={{ width: `${((idx) / list.length) * 100}%` }} />
            </div>
          </div>

          <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
            <div className={`w-40 h-40 rounded-2xl flex items-center justify-center ${ITEM_TINT[c.cat]}`}>
              <CatIcon className="w-20 h-20" />
            </div>
            <div className="mt-6 text-2xl font-bold leading-tight">{c.label}</div>
            <div className="mt-3 text-5xl font-mono font-black tabular-nums text-zinc-900">{c.qty}</div>
            <div className="text-base text-zinc-500">
              {c.itemId ? itemById(c.itemId).unit : "documento"}
            </div>
          </div>

          <div className="p-4 space-y-3">
            <BigBtn tone="green" icon={CheckCircle2} onClick={() => answer(c.id, "yes")}>Tenho</BigBtn>
            <BigBtn tone="red" icon={XCircle} onClick={() => answer(c.id, "no")}>Não tenho</BigBtn>
          </div>
        </div>
      );
    })(),

    prepresult: missing.length === 0 ? (
      <div className="flex flex-col h-full bg-green-600 text-white p-6">
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <CheckCircle2 className="w-20 h-20" />
          <div className="mt-4 text-3xl font-bold">Pode arrancar</div>
          <div className="mt-2 text-lg text-green-100">Tem tudo o que precisa</div>
        </div>
        <BigBtn tone="ghost" onClick={() => go("site")}>Cheguei ao local</BigBtn>
      </div>
    ) : (
      <div className="flex flex-col h-full bg-red-600 text-white">
        <div className="p-6 text-center">
          <AlertTriangle className="w-16 h-16 mx-auto" />
          <div className="mt-3 text-2xl font-bold">Faltam {missing.length}</div>
        </div>
        <div className="flex-1 bg-white rounded-t-3xl p-4 overflow-auto">
          <div className="space-y-2">
            {missing.map((m) => (
              <div key={m.id} className="flex items-center gap-3 p-3 rounded-xl bg-red-50 border-2 border-red-200">
                <XCircle className="w-6 h-6 text-red-600 shrink-0" />
                <span className="text-base font-medium text-zinc-900">{m.qty}× {m.label}</span>
              </div>
            ))}
          </div>
          {missingMat.length > 0 && (() => {
            const best = sourcingOptions(missingMat[0].itemId, prices)[0];
            return (
              <div className="mt-4 p-4 rounded-xl bg-cyan-50 border-2 border-cyan-300">
                <div className="text-sm font-semibold text-cyan-900 uppercase">Passar por</div>
                <div className="text-xl font-bold mt-1 leading-tight">{best.supplier.name.split("—")[0].trim()}</div>
                <div className="text-base text-zinc-700">{best.supplier.address.split(",")[0]}</div>
                <div className="mt-2 flex items-center gap-2 text-base">
                  {best.state.open
                    ? <><CheckCircle2 className="w-5 h-5 text-green-700" /><span className="text-green-800 font-semibold">{best.state.text}</span></>
                    : <><XCircle className="w-5 h-5 text-red-700" /><span className="text-red-800 font-semibold">{best.state.text}</span></>}
                  <span className="text-zinc-500">· {best.supplier.distanceKm} km</span>
                </div>
                <div className="mt-3"><BigBtn icon={Navigation}>Levar-me lá</BigBtn></div>
              </div>
            );
          })()}
          <p className="text-sm text-zinc-500 mt-4 text-center">O escritório foi avisado automaticamente.</p>
          <div className="mt-3"><BigBtn tone="ghost" onClick={() => go("site")}>Cheguei ao local</BigBtn></div>
        </div>
      </div>
    ),

    site: (
      <PhonePage title="No local" onBack={() => go("home")}>
        <div className="p-4 rounded-xl bg-cyan-50 border-2 border-cyan-300 text-center">
          <div className="text-sm text-cyan-900 font-semibold uppercase">A contar</div>
          <div className="text-4xl font-mono font-black tabular-nums text-cyan-900">2h 14</div>
          <div className="text-sm text-cyan-800">de {job.quotedHours}h previstas</div>
        </div>
        <div className="mt-4 space-y-2">
          {["Fotografar antes", "Montar mastro", "Orientar antena", "Passar cabo", "Medir nas tomadas", "Fotografar depois"]
            .map((s, i) => (
              <div key={i} className={`flex items-center gap-3 p-4 rounded-xl border-2 ${
                i < 4 ? "border-zinc-200 bg-zinc-50" : "border-zinc-300 bg-white"
              }`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                  i < 4 ? "bg-green-600" : "bg-zinc-200"
                }`}>
                  {i < 4 ? <CheckCircle2 className="w-5 h-5 text-white" /> : <span className="text-sm font-bold text-zinc-600">{i + 1}</span>}
                </div>
                <span className={`text-base ${i < 4 ? "text-zinc-400 line-through" : "font-medium"}`}>{s}</span>
              </div>
            ))}
        </div>
        <div className="mt-4"><BigBtn onClick={() => { setOutletI(0); setVals({}); go("tests"); }}>Fazer as medições</BigBtn></div>
      </PhonePage>
    ),

    tests: (() => {
      const name = OUTLETS[outletI];
      const v = vals[name];
      const results = v ? TDT_TESTS.map((t) => ({ t, v: v[t.id], r: evalTest(t, v[t.id]) })) : null;
      const ok = results && results.every((x) => x.r === "pass");

      return (
        <PhonePage title={`Tomada ${outletI + 1} de ${OUTLETS.length}`} onBack={() => go("site")}>
          <div className="text-2xl font-bold">{name}</div>

          {!v && !reading && (
            <div className="mt-6 space-y-3">
              <BigBtn icon={Camera} onClick={() => {
                setReading(true);
                setTimeout(() => { setReading(false); setVals({ ...vals, [name]: METER_READS[name] }); }, 1300);
              }}>Fotografar o medidor</BigBtn>
              <BigBtn tone="ghost" icon={Keyboard}
                onClick={() => setVals({ ...vals, [name]: { t1: "", t2: "" } })}>
                Escrever à mão
              </BigBtn>
              <p className="text-sm text-zinc-500 text-center pt-2">
                Aponte a câmara ao ecrã do medidor. Se não der, escreva à mão — dá no mesmo.
              </p>
            </div>
          )}

          {reading && (
            <div className="mt-16 flex flex-col items-center">
              <Loader2 className="w-12 h-12 text-cyan-600 animate-spin" />
              <div className="mt-4 text-lg font-medium">A ler o ecrã…</div>
            </div>
          )}

          {v && (
            <>
              <div className="mt-4 space-y-2">
                {results.map((x, i) => (
                  <div key={i} className={`flex items-center gap-3 p-3 rounded-xl border-2 ${
                    x.r === "pass" ? "border-green-300 bg-green-50"
                      : x.r === "fail" ? "border-red-400 bg-red-50" : "border-zinc-300"
                  }`}>
                    {x.r === "pass" ? <CheckCircle2 className="w-6 h-6 text-green-700 shrink-0" />
                      : x.r === "fail" ? <XCircle className="w-6 h-6 text-red-700 shrink-0" />
                        : <div className="w-6 h-6 rounded-full border-2 border-zinc-300 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-base font-medium leading-tight">{x.t.label}</div>
                      <div className="text-sm text-zinc-500">Deve ser {threshLabel(x.t)}</div>
                    </div>
                    <input value={x.v} inputMode="decimal"
                      onChange={(e) => setVals({ ...vals, [name]: { ...v, [x.t.id]: e.target.value } })}
                      className="w-24 px-2 py-2 text-lg font-mono font-bold tabular-nums text-right border-2 border-zinc-300 rounded" />
                  </div>
                ))}
              </div>
              <div className={`mt-4 p-4 rounded-xl flex items-center gap-3 ${ok ? "bg-green-600" : "bg-red-600"} text-white`}>
                {ok ? <CheckCircle2 className="w-8 h-8" /> : <XCircle className="w-8 h-8" />}
                <div className="text-lg font-bold">{ok ? "Tomada conforme" : "Fora dos valores"}</div>
              </div>
              <div className="mt-3">
                <BigBtn onClick={() => {
                  if (outletI + 1 < OUTLETS.length) setOutletI(outletI + 1);
                  else go("voice");
                }}>
                  {outletI + 1 < OUTLETS.length ? "Próxima tomada" : "Terminar medições"}
                </BigBtn>
              </div>
            </>
          )}
        </PhonePage>
      );
    })(),

    voice: (
      <PhonePage title="Como correu?" onBack={() => go("tests")}>
        <p className="text-base text-zinc-600">
          Conte pelas suas palavras. Não escolha categorias — o escritório trata disso.
        </p>
        <div className="mt-8 flex flex-col items-center">
          <button
            onClick={() => {
              if (recording) {
                setRecording(false);
                setNote("A tomada do quarto 2 está ligada a um cabo velho que já não presta. Não estava no orçamento. Falei com o senhor e ele quer saber quanto custa trocar.");
              } else { setRecording(true); setNote(""); }
            }}
            className={`w-32 h-32 rounded-full flex items-center justify-center ${
              recording ? "bg-red-600 animate-pulse" : "bg-zinc-900"
            }`}>
            <Mic className="w-14 h-14 text-white" />
          </button>
          <div className="mt-4 text-lg font-medium">
            {recording ? "A gravar… toque para parar" : note ? "Gravado" : "Toque para falar"}
          </div>
        </div>
        {note && (
          <div className="mt-6 p-4 rounded-xl bg-zinc-100 border-2 border-zinc-200">
            <div className="text-xs font-semibold text-zinc-500 uppercase">Transcrito</div>
            <p className="text-base mt-1">{note}</p>
          </div>
        )}
        <div className="mt-4 space-y-3">
          <BigBtn tone="ghost" icon={Keyboard} onClick={() => setNote(note || "…")}>Prefiro escrever</BigBtn>
          <BigBtn tone="green" disabled={!note} onClick={() => go("done")}>Fechar trabalho</BigBtn>
        </div>
      </PhonePage>
    ),

    done: (
      <div className="flex flex-col h-full bg-green-600 text-white p-6">
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <CheckCircle2 className="w-20 h-20" />
          <div className="mt-4 text-3xl font-bold">Terminado</div>
          <div className="mt-2 text-lg text-green-100">5h 30 · relatório enviado</div>
          <div className="mt-6 text-base text-green-100 px-4">
            O escritório recebeu as medições, as fotos e a sua nota de voz.
          </div>
        </div>
        <BigBtn tone="ghost" onClick={() => { setScreen("home"); setAnswers({}); setVals({}); setNote(""); setOutletI(0); setIdx(0); }}>
          Voltar ao início
        </BigBtn>
      </div>
    ),
  };

  const principles = [
    ["pin", "Sem palavra-passe", "Telemóvel associado ao técnico + PIN de 4 dígitos."],
    ["home", "Um trabalho, não uma agenda", "Só o próximo trabalho. Tudo o resto é ruído no telhado."],
    ["prep", "Uma decisão por ecrã", "5 itens, não 17. Nada de listas para interpretar."],
    ["prep", "Quantidade em corpo enorme", "O número é a informação. O SKU não diz nada a ninguém."],
    ["prepresult", "A falha resolve-se sozinha", "Em falta → fornecedor mais próximo aberto, já com rota."],
    ["tests", "Fotografar em vez de escrever", "OCR do ecrã do medidor. Teclado só como alternativa."],
    ["tests", "Cor + ícone + palavra", "Nunca só a cor — 1 em 12 homens não distingue verde de vermelho."],
    ["voice", "Ele conta, o escritório classifica", "Nada de dropdowns de causa-raiz a meio da tarde."],
  ];

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 flex flex-col lg:flex-row gap-8 justify-center items-start">
      <div className="mx-auto shrink-0">
        <div className="rounded-3xl border-8 border-zinc-900 overflow-hidden bg-white shadow-xl"
          style={{ width: 380, height: 740 }}>
          {screens[screen]}
        </div>
        <div className="text-center text-xs text-zinc-400 mt-2">
          Ecrã: <span className="font-mono">{screen}</span> · toque para navegar
        </div>
      </div>

      <div className="flex-1 min-w-0 max-w-md">
        <h2 className="text-base font-semibold">Porquê assim</h2>
        <p className="text-sm text-zinc-600 mt-1">
          O técnico não falha a tocar no ecrã. Falha a ler uma lista e a mapeá-la ao mundo real.
        </p>
        <div className="mt-4 space-y-2">
          {principles.map(([s, t, d], i) => (
            <div key={i}
              className={`p-3 rounded border ${screen === s ? "border-cyan-400 bg-cyan-50" : "border-zinc-200 bg-white"}`}>
              <div className="text-sm font-medium flex items-center gap-2">
                {t}
                {screen === s && <Pill tone="cyan">neste ecrã</Pill>}
              </div>
              <div className="text-xs text-zinc-600 mt-0.5">{d}</div>
            </div>
          ))}
        </div>
        <div className="mt-4 p-3 rounded bg-amber-50 border border-amber-200">
          <div className="text-sm font-medium text-amber-900">O compromisso a vigiar</div>
          <p className="text-xs text-amber-800 mt-1">
            Nunca acrescentar um botão "está tudo bem". Poupa 5 toques e destrói os dados de que
            todo o resto do produto depende. Tornar rápido, não opcional.
          </p>
        </div>
      </div>
    </div>
  );
}

function PhonePage({ title, onBack, children }) {
  return (
    <div className="flex flex-col h-full bg-white">
      <div className="flex items-center gap-2 px-3 py-3 border-b-2 border-zinc-100 shrink-0">
        <button onClick={onBack} className="p-2 -ml-1"><ChevronLeft className="w-6 h-6 text-zinc-600" /></button>
        <span className="text-base font-semibold">{title}</span>
      </div>
      <div className="flex-1 overflow-auto p-4">{children}</div>
    </div>
  );
}

/* ---------------------------- NOTES TAB --------------------------- */

function Notes() {
  const block = (title, items) => (
    <Section title={title}>
      <ul className="space-y-1.5 text-sm text-zinc-700">
        {items.map((t, i) => (
          <li key={i} className="flex gap-2"><span className="text-zinc-400">·</span><span>{t}</span></li>
        ))}
      </ul>
    </Section>
  );

  return (
    <div className="space-y-5">
      <div className="bg-white rounded border border-zinc-200 p-4">
        <h2 className="text-base font-semibold">Notas do modelo</h2>
        <p className="text-sm text-zinc-600 mt-1">
          Protótipo com dados fictícios. Sem backend, sem persistência — recarregar repõe o estado inicial.
        </p>
      </div>

      {block("Arquitetura recomendada", [
        "Multi-tenant desde o início: tenant_id em todas as tabelas + row-level security no Postgres. Vender single-tenant primeiro, mas não retrofitar isolamento depois.",
        "Offline-first no telemóvel: o técnico está num telhado sem rede. Fila local + sincronização, IDs gerados no cliente.",
        "Não construir faturação. Portugal exige software certificado pela AT — integrar com Moloni / InvoiceXpress / Vendus.",
        "Google Places para morada e horário dos fornecedores: guardar place_id permanentemente, restantes campos com refresh periódico (os termos limitam a cache).",
      ])}

      {block("O que diferencia isto do Jobber / ServiceTitan / Simpro", [
        "Readiness como gate de despacho, não como checklist dentro do trabalho.",
        "AAR como dados estruturados que alimentam o orçamento seguinte, não como PDF arquivado.",
        "Histórico de preços por fornecedor cruzado com horário e distância → rota de recolha.",
        "Protocolos de teste da especialidade (DVB-T2) prontos a usar, não formulários em branco.",
      ])}

      {block("Simplificação para técnicos pouco à-vontade com tecnologia", [
        "Três âmbitos por item: 'no trabalho' (telemóvel), 'stock carrinha' (auditoria semanal), 'escritório' (automático). A lista do técnico passou de 17 para 5 itens sem perder verificações.",
        "A auditoria da carrinha é feita uma vez por semana, no armazém, sem pressa — não a cada trabalho, no carro, à pressa.",
        "Um item por ecrã, dois botões grandes. Sem listas para interpretar.",
        "Zero escrita obrigatória: fotografia do ecrã do medidor (OCR) e nota de voz. Teclado existe sempre como alternativa.",
        "O técnico não classifica causas-raiz. Descreve por palavras dele; o escritório atribui a taxonomia — caso contrário toda a gente escolhe a primeira opção.",
        "Alvos de toque ≥ 56px (luvas), contraste alto (sol direto), pass/fail com ícone + palavra + cor (daltonismo).",
        "Nunca acrescentar um botão 'confirmar tudo'. Poupa 5 toques e destrói a qualidade dos dados de que o dashboard depende.",
      ])}

      {block("Próximos passos sugeridos", [
        "Usar isto em 5 trabalhos reais com a TDT.pt antes de escrever backend. O que falhar no papel falha no código.",
        "Medir a baseline de first-time fix atual — sem isso não há como provar valor a um cliente.",
        "Modelo de dados: tenant, user, client, quote, job, checklist_template, checklist_item, supplier, item, price_point, receipt, job_test, aar, action.",
        "Só depois: Next.js + Postgres (RLS) + React Native ou PWA para o telemóvel.",
      ])}
    </div>
  );
}
