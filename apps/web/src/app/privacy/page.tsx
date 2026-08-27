/*
 * Privacy Policy — production-readiness item 5. Content is real and
 * GDPR-structured (controller identity, purposes/legal basis, retention,
 * data subject rights, sub-processors, cookies/analytics disclosure,
 * contact), but the bracketed [placeholders] are NOT filled with
 * invented company details — that would be worse than leaving them
 * blank, since a fabricated NIPC/address reads as real. Whoever owns
 * this company must fill those in before this page is genuinely
 * compliant; the structure and substance around them is complete.
 *
 * Portuguese, matching the rest of this app's locale (its actual
 * audience — Portuguese telecom installers — not an English-first
 * marketing site).
 */

import Link from "next/link";
import { Radio } from "lucide-react";

const SECTION_CLASS = "space-y-2";
const H2_CLASS = "text-base font-semibold text-zinc-900 mt-8 mb-2";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="max-w-2xl mx-auto px-4 py-10">
        <Link href="/login" className="flex items-center gap-2 mb-8">
          <Radio className="w-5 h-5 text-cyan-600" strokeWidth={2.5} />
          <span className="font-mono font-bold uppercase tracking-wider text-lg">FieldReady</span>
        </Link>

        <h1 className="text-xl font-semibold">Política de Privacidade</h1>
        <p className="text-sm text-zinc-500 mt-1">Última atualização: [data]</p>

        <div className="mt-6 text-sm leading-relaxed text-zinc-700 space-y-1">
          <p>
            Esta política explica que dados pessoais o FieldReady recolhe, para quê, com que
            base legal, durante quanto tempo, e quais são os seus direitos — em conformidade
            com o Regulamento Geral sobre a Proteção de Dados (RGPD).
          </p>
        </div>

        <h2 className={H2_CLASS}>1. Quem é o responsável pelo tratamento</h2>
        <div className={SECTION_CLASS}>
          <p className="text-sm text-zinc-700">
            [Nome legal da empresa], com sede em [morada da sede], NIPC [número], é a
            responsável pelo tratamento dos dados pessoais descritos nesta política.
            Contacto para assuntos de proteção de dados: [email de contacto/DPO].
          </p>
        </div>

        <h2 className={H2_CLASS}>2. Que dados tratamos</h2>
        <div className={SECTION_CLASS}>
          <ul className="text-sm text-zinc-700 list-disc pl-5 space-y-1.5">
            <li>
              <strong>Conta e acesso:</strong> nome, email, palavra-passe (guardada apenas em
              forma cifrada/hash, nunca em texto simples), função (técnico ou escritório).
            </li>
            <li>
              <strong>Dados de clientes finais:</strong> nome, morada, contactos, inseridos
              pela sua empresa para gerir orçamentos e trabalhos — o FieldReady trata estes
              dados em nome da sua empresa, que é a responsável por essa recolha.
            </li>
            <li>
              <strong>Dados de execução de trabalhos:</strong> fotografias, notas de voz e
              texto, resultados de testes, localização do local de trabalho, registadas pelo
              técnico durante um trabalho.
            </li>
            <li>
              <strong>Dados técnicos:</strong> endereço IP, tipo de dispositivo, registos de
              acesso, para segurança e resolução de problemas.
            </li>
            <li>
              <strong>Dados de utilização anónimos/agregados:</strong> através do Google
              Analytics e do Vercel Analytics — ver secção 6.
            </li>
          </ul>
        </div>

        <h2 className={H2_CLASS}>3. Para quê e com que base legal</h2>
        <div className={SECTION_CLASS}>
          <ul className="text-sm text-zinc-700 list-disc pl-5 space-y-1.5">
            <li>
              <strong>Prestar o serviço</strong> (gestão de orçamentos, trabalhos, conformidade
              ITED) — execução do contrato com a sua empresa.
            </li>
            <li>
              <strong>Segurança e prevenção de abuso</strong> (limitação de tentativas de
              acesso, deteção de atividade anómala) — interesse legítimo.
            </li>
            <li>
              <strong>Cumprimento de obrigações legais</strong> (por exemplo, prazos e registos
              exigidos pelo Manual ITED / DL 123/2009) — obrigação legal.
            </li>
            <li>
              <strong>Melhoria do produto</strong>, através de dados de utilização agregados —
              interesse legítimo, ou consentimento quando exigido (ver secção 6).
            </li>
          </ul>
        </div>

        <h2 className={H2_CLASS}>4. Durante quanto tempo</h2>
        <div className={SECTION_CLASS}>
          <p className="text-sm text-zinc-700">
            Os dados são conservados enquanto a conta da sua empresa estiver ativa, e depois
            pelo período exigido por lei para registos de conformidade ITED (documentação
            técnica e termos de responsabilidade têm prazos de conservação próprios definidos
            no Manual ITED / DL 123/2009). Após esse período, os dados são eliminados ou
            anonimizados. [Confirmar prazo exato de conservação após encerramento de conta.]
          </p>
        </div>

        <h2 className={H2_CLASS}>5. Com quem partilhamos dados</h2>
        <div className={SECTION_CLASS}>
          <p className="text-sm text-zinc-700 mb-2">
            Não vendemos dados pessoais. Partilhamos apenas com prestadores de serviço
            estritamente necessários para operar o FieldReady, cada um agindo como
            subcontratante:
          </p>
          <ul className="text-sm text-zinc-700 list-disc pl-5 space-y-1.5">
            <li><strong>Supabase</strong> — base de dados e autenticação.</li>
            <li><strong>Vercel</strong> — alojamento da aplicação web.</li>
            <li>
              <strong>Google (Places API, Google Analytics)</strong> — sincronização de dados
              de fornecedores e análise de utilização.
            </li>
            <li>
              <strong>Veryfi</strong> [confirmar se ativo] — leitura automática (OCR) de
              recibos de fornecedores, quando configurado.
            </li>
          </ul>
        </div>

        <h2 className={H2_CLASS}>6. Cookies e análise de utilização</h2>
        <div className={SECTION_CLASS}>
          <p className="text-sm text-zinc-700 mb-2">
            Usamos dois serviços de análise, com naturezas diferentes:
          </p>
          <ul className="text-sm text-zinc-700 list-disc pl-5 space-y-1.5">
            <li>
              <strong>Vercel Analytics</strong> não usa cookies nem identifica visitantes
              individualmente — não requer consentimento.
            </li>
            <li>
              <strong>Google Analytics</strong> usa cookies para distinguir visitas e sessões.
              Só é ativado depois de aceitar no aviso de cookies apresentado na primeira
              visita; pode alterar essa escolha a qualquer momento limpando os dados deste
              site no seu navegador.
            </li>
          </ul>
        </div>

        <h2 className={H2_CLASS}>7. Os seus direitos</h2>
        <div className={SECTION_CLASS}>
          <p className="text-sm text-zinc-700">
            Tem direito a aceder, corrigir, apagar, limitar ou opor-se ao tratamento dos seus
            dados pessoais, e a portabilidade dos mesmos. Para exercer estes direitos,
            contacte [email de contacto/DPO]. Tem também o direito de apresentar reclamação à
            Comissão Nacional de Proteção de Dados (CNPD).
          </p>
        </div>

        <h2 className={H2_CLASS}>8. Contacto</h2>
        <div className={SECTION_CLASS}>
          <p className="text-sm text-zinc-700">
            Questões sobre esta política: [email de contacto]. Para questões de suporte ao
            produto, use o formulário de Suporte dentro da aplicação.
          </p>
        </div>

        <div className="mt-10 pt-6 border-t border-zinc-200 text-xs text-zinc-400">
          <Link href="/terms" className="hover:text-zinc-600 underline">
            Termos de Serviço
          </Link>
        </div>
      </div>
    </div>
  );
}
