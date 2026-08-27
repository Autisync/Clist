/*
 * Terms of Service — production-readiness item 5, sibling to
 * privacy/page.tsx. Same placeholder discipline: bracketed fields are
 * left for the company owner to fill in with real legal/registration
 * details, never invented.
 */

import Link from "next/link";
import { Radio } from "lucide-react";

const H2_CLASS = "text-base font-semibold text-zinc-900 mt-8 mb-2";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="max-w-2xl mx-auto px-4 py-10">
        <Link href="/login" className="flex items-center gap-2 mb-8">
          <Radio className="w-5 h-5 text-cyan-600" strokeWidth={2.5} />
          <span className="font-mono font-bold uppercase tracking-wider text-lg">FieldReady</span>
        </Link>

        <h1 className="text-xl font-semibold">Termos de Serviço</h1>
        <p className="text-sm text-zinc-500 mt-1">Última atualização: [data]</p>

        <p className="mt-6 text-sm leading-relaxed text-zinc-700">
          Estes termos regulam o acesso e utilização do FieldReady por parte da sua empresa
          e dos seus utilizadores (escritório e técnicos). Ao criar ou utilizar uma conta,
          aceita estes termos em nome da empresa que representa.
        </p>

        <h2 className={H2_CLASS}>1. O serviço</h2>
        <p className="text-sm text-zinc-700">
          O FieldReady é uma aplicação de gestão de prontidão de campo, relatórios pós-ação e
          conformidade ITED para instaladores de telecomunicações em Portugal. O serviço é
          disponibilizado como está, com as funcionalidades correspondentes ao perfil de
          conformidade ({"básico"}, {"ITED pronto"} ou {"ITED completo"}) contratado pela sua
          empresa.
        </p>

        <h2 className={H2_CLASS}>2. Conta e responsabilidade dos utilizadores</h2>
        <div className="space-y-2">
          <p className="text-sm text-zinc-700">
            A sua empresa é responsável por manter a confidencialidade das credenciais de
            acesso (palavras-passe de escritório, PINs de técnico) e por toda a atividade
            realizada através da sua conta. Deve revogar de imediato o acesso de um
            dispositivo ou utilizador que deixe de estar autorizado.
          </p>
          <p className="text-sm text-zinc-700">
            A classificação de âmbito ITED de um trabalho, e qualquer decisão de
            conformidade, é sempre da responsabilidade do pessoal de escritório da sua
            empresa — o FieldReady regista e organiza a informação, mas não substitui o
            critério técnico e legal exigido pela regulamentação aplicável.
          </p>
        </div>

        <h2 className={H2_CLASS}>3. Dados e propriedade</h2>
        <p className="text-sm text-zinc-700">
          Os dados que a sua empresa insere (clientes, orçamentos, trabalhos, fotografias,
          resultados de testes) pertencem à sua empresa. O FieldReady trata-os apenas para
          prestar o serviço, nos termos descritos na Política de Privacidade. Ao encerrar a
          conta, a sua empresa pode solicitar a exportação ou eliminação dos seus dados,
          sujeito aos prazos legais de conservação aplicáveis a registos de conformidade
          ITED.
        </p>

        <h2 className={H2_CLASS}>4. Disponibilidade e limitações</h2>
        <p className="text-sm text-zinc-700">
          O FieldReady depende de serviços de terceiros (base de dados, alojamento,
          sincronização de fornecedores) para funcionar. Fazemos um esforço razoável para
          manter o serviço disponível, mas não garantimos disponibilidade ininterrupta.
          [Confirmar se aplicável um SLA/nível de suporte contratual específico.]
        </p>

        <h2 className={H2_CLASS}>5. Alterações a estes termos</h2>
        <p className="text-sm text-zinc-700">
          Podemos atualizar estes termos periodicamente. Alterações materiais serão
          comunicadas à sua empresa com uma antecedência razoável.
        </p>

        <h2 className={H2_CLASS}>6. Lei aplicável</h2>
        <p className="text-sm text-zinc-700">
          Estes termos regem-se pela lei portuguesa. [Confirmar foro/jurisdição contratual
          preferida, se aplicável.]
        </p>

        <h2 className={H2_CLASS}>7. Contacto</h2>
        <p className="text-sm text-zinc-700">
          Questões sobre estes termos: [email de contacto]. Para questões de suporte ao
          produto, use o formulário de Suporte dentro da aplicação.
        </p>

        <div className="mt-10 pt-6 border-t border-zinc-200 text-xs text-zinc-400">
          <Link href="/privacy" className="hover:text-zinc-600 underline">
            Política de Privacidade
          </Link>
        </div>
      </div>
    </div>
  );
}
