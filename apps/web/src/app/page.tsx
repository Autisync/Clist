/*
 * Public marketing landing page — the actual root ("/") of the domain.
 * Previously a bare `redirect("/office")`; nothing else in the app
 * depended on that (checked: middleware.ts's matcher only ever covers
 * /office, /field, /admin — never "/" — and login/page.tsx's own default
 * redirect target is "/office/jobs", not "/"), so this is safe to replace
 * outright rather than needing to relocate the old behavior anywhere.
 *
 * Content discipline: every claim on this page is either a real,
 * built feature (cross-checked against CLAUDE.md's phase build log) or a
 * real, cited fact from 01-PRD.md/ited-ref-mapping.md (the DL 123/2009
 * fine ceiling, the Manual ITED table numbers, the ANACOM Procedimento
 * edition). No fabricated customer counts, logos, testimonials, or
 * "trusted by" claims — PRD §4 is explicit that self-serve signup and a
 * public marketing site were both non-goals until a second real
 * customer exists, and this product has no real usage data yet to make
 * an honest metric out of. The CTA is "pedir demonstração" (request a
 * demo), not a signup form, for the same reason — there is no self-serve
 * onboarding path to sell into.
 */

import Link from "next/link";
import {
  Radio,
  Wrench,
  TrendingDown,
  ShieldAlert,
  ClipboardCheck,
  Mic,
  FileCheck2,
  Camera,
  BarChart3,
  Link2,
  WifiOff,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";

const DEMO_MAILTO =
  "mailto:info@autisync.com?subject=" +
  encodeURIComponent("Pedido de demonstração — FieldReady");

const NAV_LINKS = [
  { href: "#funcionalidades", label: "Funcionalidades" },
  { href: "#conformidade", label: "Conformidade ITED" },
  { href: "#como-funciona", label: "Como funciona" },
];

const PROBLEMS = [
  {
    icon: Wrench,
    title: "Visitas repetidas",
    body: "Trabalhos despachados sem material ou ferramentas obrigam a segundas visitas — cada uma apaga margem e atrasa o cliente seguinte.",
  },
  {
    icon: TrendingDown,
    title: "Orçamentos que nunca melhoram",
    body: "Horas e materiais reais raramente são comparados com o que foi orçamentado, por isso o próximo orçamento repete o mesmo erro do anterior.",
  },
  {
    icon: ShieldAlert,
    title: "Risco de coima até 1.000.000 €",
    body: "REF e termo de responsabilidade sob o regime ITED (DL 123/2009) tratados com papelada solta, sem prazos controlados — nas infrações mais graves, para grandes infratores.",
  },
];

const FEATURES = [
  {
    icon: ClipboardCheck,
    title: "Orçamento → material → despacho",
    body: "Cada trabalho nasce de um orçamento com lista de materiais real, e só é despachado quando a checklist de prontidão está genuinamente completa — sem atalho de \"confirmar tudo\".",
  },
  {
    icon: Mic,
    title: "Execução por voz, quase sem digitar",
    body: "O técnico regista o que aconteceu por voz e fotografia. A classificação de âmbito ITED e o critério técnico ficam sempre com o escritório, nunca com o telemóvel.",
  },
  {
    icon: FileCheck2,
    title: "Conformidade ITED completa",
    body: "Protocolos de teste (F11–F18), montagem do REF, termo de responsabilidade e prazos estatutários calculados sobre o calendário real de feriados portugueses.",
  },
  {
    icon: Camera,
    title: "Preços de fornecedores sempre atualizados",
    body: "Leitura automática (OCR) de recibos, histórico de preços por fornecedor, e sugestão do fornecedor aberto mais barato quando falta material.",
  },
  {
    icon: BarChart3,
    title: "Dashboard com números, não opinião",
    body: "First-time-fix rate, desvio de horas por tipo de trabalho e por técnico — calculados a partir do que foi realmente registado em campo.",
  },
  {
    icon: Link2,
    title: "Portal do cliente",
    body: "Um link, sem conta nem palavra-passe, para o cliente acompanhar o estado do trabalho e ver fotografias — nada financeiro ou interno é exposto.",
  },
  {
    icon: WifiOff,
    title: "Funciona sem rede",
    body: "Fila de sincronização com reprodução idempotente: o técnico trabalha offline no local, os dados chegam assim que o sinal voltar.",
  },
  {
    icon: Radio,
    title: "Um perfil de conformidade por cliente",
    body: "Básico, ITED pronto ou ITED completo — o mesmo produto cresce com o instalador, sem trocar de aplicação a meio do percurso.",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Escritório orça e despacha",
    body: "Cria o orçamento, confirma a lista de materiais e despacha o trabalho assim que a prontidão está completa.",
  },
  {
    n: "2",
    title: "Técnico executa no telemóvel",
    body: "Offline, por voz e por foto, um ecrã de cada vez — pensado para mãos com luvas e sinal fraco.",
  },
  {
    n: "3",
    title: "Conformidade fica pronta sozinha",
    body: "REF, termo de responsabilidade e prazos preenchidos a partir do que já foi registado — nada digitado duas vezes.",
  },
];

const REG_CHIPS = ["DL 123/2009", "Manual ITED 4.ª edição", "Procedimento ANACOM, Edição 2024", "RGPD / CNPD"];

const STAT_STRIP = [
  { value: "21", label: "formulários ITED cobertos" },
  { value: "0", label: "atalhos de \"confirmar tudo\"" },
  { value: "100%", label: "offline-first no telemóvel" },
];

export default function LandingPage() {
  return (
    <div className="bg-white text-zinc-900">
      {/* ---------------------------------------------------------------- */}
      {/* Nav                                                               */}
      {/* ---------------------------------------------------------------- */}
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-zinc-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-cyan-600" strokeWidth={2.5} />
            <span className="font-mono font-bold uppercase tracking-wider text-sm">FieldReady</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm text-zinc-600">
            {NAV_LINKS.map((l) => (
              <a key={l.href} href={l.href} className="hover:text-zinc-900">
                {l.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/login" className="hidden sm:inline text-sm font-medium text-zinc-600 hover:text-zinc-900">
              Entrar
            </Link>
            <a
              href={DEMO_MAILTO}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800"
            >
              Pedir demonstração
            </a>
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                              */}
      {/* ---------------------------------------------------------------- */}
      <section className="relative overflow-hidden bg-zinc-900 text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 50% at 50% 0%, rgba(8,145,178,0.25) 0%, rgba(8,145,178,0) 70%)",
          }}
        />
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-16 pb-20 sm:pt-24 sm:pb-28">
          <div className="max-w-2xl">
            <p className="font-mono text-xs uppercase tracking-widest text-cyan-400 mb-4">
              Para instaladores de telecomunicações em Portugal
            </p>
            <h1 className="text-3xl sm:text-5xl font-semibold tracking-tight leading-tight">
              Menos segundas visitas.
              <br />
              Conformidade ITED sem esforço.
            </h1>
            <p className="mt-5 text-base sm:text-lg text-zinc-300 leading-relaxed max-w-xl">
              O FieldReady organiza orçamentos, despacho, execução em campo e os
              relatórios que a lei exige — antenas, TDT, satélite, MATV e fibra,
              numa só aplicação pensada para o técnico no terreno.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href={DEMO_MAILTO}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded bg-cyan-500 text-zinc-900 text-sm font-semibold hover:bg-cyan-400"
              >
                Pedir demonstração
                <ArrowRight className="w-4 h-4" />
              </a>
              <a
                href="#funcionalidades"
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded border border-zinc-700 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
              >
                Ver funcionalidades
              </a>
            </div>
            <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3">
              {STAT_STRIP.map((s) => (
                <div key={s.label}>
                  <div className="font-mono text-2xl font-semibold text-white">{s.value}</div>
                  <div className="text-xs text-zinc-400">{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Readiness-card mockup — a genuine representation of the real
              office UI's layout/tone (checklist rows, a readiness
              percentage), built from plain markup rather than a captured
              screenshot, so nothing tenant-specific or fixture-derived
              can ever leak onto a public page through this. */}
          <div className="hidden lg:block absolute right-6 xl:right-16 top-20 w-80">
            <div className="rounded-lg border border-zinc-700 bg-zinc-800/80 shadow-2xl shadow-cyan-950/40 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
                <div>
                  <div className="font-mono text-[11px] text-zinc-400">TDT-2451</div>
                  <div className="text-sm font-medium text-white">Instalação TDT — Sintra</div>
                </div>
                <span className="text-xs font-mono font-semibold text-green-400 bg-green-400/10 px-2 py-1 rounded">
                  100%
                </span>
              </div>
              <div className="p-3 space-y-1.5">
                {["Antena UHF conferida", "Cabo coaxial 17VATC", "Termo de responsabilidade", "Kit de fixação exterior"].map((label) => (
                  <div key={label} className="flex items-center gap-2 px-2 py-1.5 rounded bg-zinc-900/60 text-sm text-zinc-200">
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                    {label}
                  </div>
                ))}
              </div>
              <div className="px-4 py-3 border-t border-zinc-700 text-xs text-zinc-400">
                Pronto para despacho — fase de despacho concluída
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Problem                                                           */}
      {/* ---------------------------------------------------------------- */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
        <h2 className="text-2xl sm:text-3xl font-semibold text-center">
          Os três problemas que corroem a margem de qualquer instalador
        </h2>
        <div className="mt-10 grid sm:grid-cols-3 gap-6">
          {PROBLEMS.map((p) => (
            <div key={p.title} className="p-5 rounded-lg border border-zinc-200">
              <p.icon className="w-6 h-6 text-cyan-600" strokeWidth={2} />
              <h3 className="mt-3 font-semibold text-zinc-900">{p.title}</h3>
              <p className="mt-1.5 text-sm text-zinc-600 leading-relaxed">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Features                                                          */}
      {/* ---------------------------------------------------------------- */}
      <section id="funcionalidades" className="bg-zinc-50 border-y border-zinc-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
          <h2 className="text-2xl sm:text-3xl font-semibold text-center">
            Tudo o que uma instalação precisa, do orçamento ao ANACOM
          </h2>
          <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {FEATURES.map((f) => (
              <div key={f.title} className="p-5 rounded-lg bg-white border border-zinc-200">
                <f.icon className="w-5 h-5 text-cyan-600" strokeWidth={2} />
                <h3 className="mt-3 text-sm font-semibold text-zinc-900">{f.title}</h3>
                <p className="mt-1.5 text-xs text-zinc-600 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* How it works                                                      */}
      {/* ---------------------------------------------------------------- */}
      <section id="como-funciona" className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
        <h2 className="text-2xl sm:text-3xl font-semibold text-center">Como funciona</h2>
        <div className="mt-10 grid sm:grid-cols-3 gap-8">
          {STEPS.map((s) => (
            <div key={s.n}>
              <div className="w-9 h-9 rounded-full bg-zinc-900 text-white font-mono font-semibold flex items-center justify-center text-sm">
                {s.n}
              </div>
              <h3 className="mt-3 font-semibold text-zinc-900">{s.title}</h3>
              <p className="mt-1.5 text-sm text-zinc-600 leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Compliance credibility band                                       */}
      {/* ---------------------------------------------------------------- */}
      <section id="conformidade" className="bg-zinc-900 text-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20 text-center">
          <h2 className="text-2xl sm:text-3xl font-semibold">
            Construído sobre a regulamentação real, não uma aproximação
          </h2>
          <p className="mt-4 max-w-2xl mx-auto text-zinc-300 leading-relaxed">
            Os limites de teste dos protocolos ITED vêm diretamente do Manual ITED
            4.ª edição (Tabelas 6.1, 6.7, 6.9, 6.12 e 6.17), e o modelo do REF
            segue o Procedimento de Avaliação Edição 2024 da ANACOM — cada
            protocolo fica marcado com a sua fonte e é revisto antes de ser
            ativado, nunca editado depois de publicado.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {REG_CHIPS.map((c) => (
              <span
                key={c}
                className="px-3 py-1.5 rounded-full border border-zinc-700 text-xs font-mono text-zinc-300"
              >
                {c}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* CTA                                                               */}
      {/* ---------------------------------------------------------------- */}
      <section id="contacto" className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20 text-center">
        <h2 className="text-2xl sm:text-3xl font-semibold">Pronto para ver o FieldReady em ação?</h2>
        <p className="mt-3 text-zinc-600 max-w-xl mx-auto">
          Marcamos uma demonstração com os seus próprios trabalhos e
          fornecedores — sem dados fictícios.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <a
            href={DEMO_MAILTO}
            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded bg-zinc-900 text-white text-sm font-semibold hover:bg-zinc-800"
          >
            Pedir demonstração
            <ArrowRight className="w-4 h-4" />
          </a>
          <Link
            href="/login"
            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded border border-zinc-300 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Já é cliente? Entrar
          </Link>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Footer                                                            */}
      {/* ---------------------------------------------------------------- */}
      <footer className="bg-zinc-900 text-zinc-400 border-t border-zinc-800">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Radio className="w-4 h-4 text-cyan-500" strokeWidth={2.5} />
              <span className="font-mono font-bold uppercase tracking-wider text-sm text-white">
                FieldReady
              </span>
            </div>
            <div className="flex items-center gap-5 text-xs">
              <Link href="/privacy" className="hover:text-white">
                Privacidade
              </Link>
              <Link href="/terms" className="hover:text-white">
                Termos
              </Link>
              <Link href="/login" className="hover:text-white">
                Entrar
              </Link>
            </div>
          </div>
          <p className="mt-6 text-xs leading-relaxed max-w-2xl">
            FieldReady é propriedade da Autisync e é operado diretamente pela
            Autisync (MAHELDOM CONSULTING, LDA).
          </p>
          <p className="mt-2 text-xs text-zinc-500">
            © {new Date().getFullYear() /* build-time only — a static marketing
            page, no per-request date logic that would need a client
            component */} FieldReady.
          </p>
        </div>
      </footer>
    </div>
  );
}
