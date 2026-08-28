/*
 * Privacy Policy — production-readiness item 5. GDPR-structured
 * (controller identity, purposes/legal basis, retention, data subject
 * rights, sub-processors, cookies/analytics disclosure, contact).
 *
 * Controller identity: MAHELDOM CONSULTING, LDA (trading as Autisync),
 * NIF 5003472418, registered in Luanda, Angola — confirmed directly by
 * the company owner, not invented. Labelled "NIF" rather than "NIPC"
 * deliberately: NIPC specifically denotes a Portugal-registered entity's
 * tax number (always 9 digits), which this isn't (a 10-digit number,
 * matching Angola's AGT-issued NIF format instead) — using "NIPC" here
 * would misstate where the controller is actually registered, even
 * though the service itself targets Portuguese telecom installers under
 * Portuguese RGPD/CNPD and ITED regulation. Veryfi is listed as not yet
 * active per the owner's own confirmation (still the fixture-backed
 * stub apps/api/README.md describes) — update this section the day real
 * Veryfi credentials go live in production.
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
        <p className="text-sm text-zinc-500 mt-1">Última atualização: 28 de agosto de 2026</p>

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
            MAHELDOM CONSULTING, LDA (nome comercial: Autisync), com sede em Rua Lar do
            Patriota, Edifício do Shopping Jardim do Patriota, Patriota, Luanda, Angola,
            NIF 5003472418, é a responsável pelo tratamento dos dados pessoais descritos
            nesta política. Contacto para assuntos de proteção de dados: info@autisync.com.
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
            no Manual ITED / DL 123/2009). Terminado esse período de conservação
            obrigatória, os dados são eliminados ou anonimizados num prazo razoável a
            partir do encerramento da conta ou de um pedido nesse sentido.
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
              <strong>Veryfi</strong> — leitura automática (OCR) de recibos de
              fornecedores. Ainda não está ativo em produção; esta secção será
              atualizada quando entrar em funcionamento.
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
            contacte info@autisync.com. Tem também o direito de apresentar reclamação à
            Comissão Nacional de Proteção de Dados (CNPD).
          </p>
        </div>

        <h2 className={H2_CLASS}>8. Contacto</h2>
        <div className={SECTION_CLASS}>
          <p className="text-sm text-zinc-700">
            Questões sobre esta política: info@autisync.com. Para questões de suporte ao
            produto, use o formulário de Suporte dentro da aplicação.
          </p>
        </div>

        <div className="mt-10 pt-6 border-t border-zinc-200 text-xs text-zinc-400 space-y-2">
          <p>
            FieldReady é propriedade da Autisync e é operado diretamente pela Autisync
            (MAHELDOM CONSULTING, LDA).
          </p>
          <Link href="/terms" className="hover:text-zinc-600 underline">
            Termos de Serviço
          </Link>
        </div>
      </div>
    </div>
  );
}
