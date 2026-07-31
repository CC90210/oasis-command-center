import type { Metadata } from "next";
import { LegalPage, LegalSection, LegalCallout } from "@/components/legal/LegalPage";
import {
  DATA_MATRIX,
  SUBPROCESSORS,
  LEGAL_CONTACTS,
  LEGAL_ENTITY,
  LEGAL_PRINCIPAL_PLACE,
} from "@/lib/legal/constants";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How OASIS AI Solutions collects, uses, shares, and retains personal information, including data processed by AI and large language models.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      subtitle={`How ${LEGAL_ENTITY} collects, uses, shares, and retains personal information — including what is sent to third-party AI providers.`}
    >
      <LegalSection n={1} title="Who we are">
        <p>
          {LEGAL_ENTITY} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) operates the OASIS
          Agent Command Center at oasisai.work. Our principal place of business is{" "}
          {LEGAL_PRINCIPAL_PLACE}. For privacy questions, or to exercise any right
          described below, contact{" "}
          <a href={`mailto:${LEGAL_CONTACTS.privacy}`}>{LEGAL_CONTACTS.privacy}</a>.
        </p>
        <p>
          The Command Center is a multi-tenant product. Where you submit
          information through a form published by one of our customers (a
          &ldquo;tenant&rdquo;), that tenant is the controller of your
          information and we process it on their behalf as a service provider.
        </p>
      </LegalSection>

      <LegalSection n={2} title="AI data processing and machine learning">
        <p>
          This product is built on artificial intelligence. Automated systems and
          large language models read, classify, summarise, and act on the data you
          submit. You should assume that content you enter into an agent chat, and
          the contents of any document you upload for extraction, are transmitted
          to a third-party model provider for processing.
        </p>

        <h3>What is sent to model providers</h3>
        <ul>
          <li>
            Messages and instructions you type into any agent or chat surface.
          </li>
          <li>
            Lead and application records when they are included in the context of
            an agent task (for example, drafting a reply about a specific deal).
          </li>
          <li>
            <strong>
              The full contents of documents you upload for automated field
              extraction
            </strong>{" "}
            — which for funding applications routinely includes government
            identifiers such as Social Security Numbers, dates of birth, and
            employer identification numbers.
          </li>
        </ul>

        <h3>Which providers</h3>
        <p>
          Depending on the task, content may be routed to Anthropic PBC (Claude),
          OpenAI, L.L.C. (GPT), or Google LLC (Gemini). All three process data on
          servers located in the United States. The full subprocessor list, and
          what each one receives, is in section 5.
        </p>

        <h3>Automated decision-making</h3>
        <p>
          Agents in this product can classify inbound messages, score and route
          leads, and draft outbound communications without a human reviewing each
          step. These are operational decisions about workflow — they do not by
          themselves determine eligibility for credit, employment, housing, or
          insurance. Transactional messages such as submission confirmations and
          welcome emails are sent automatically. A human operator reviews and
          approves any other communication sent on a tenant&rsquo;s behalf and
          any financial action.
        </p>
        <p>
          If you are in Quebec, you have the right under the{" "}
          <em>Act respecting the protection of personal information in the private
          sector</em> (Law 25) to be informed when a decision about you is based
          exclusively on automated processing, and to submit observations to a
          human. Write to{" "}
          <a href={`mailto:${LEGAL_CONTACTS.privacy}`}>{LEGAL_CONTACTS.privacy}</a>{" "}
          to exercise that right.
        </p>

        <h3>Training</h3>
        <p>
          We do not train our own models on your data. We do not sell your data.
          Model providers operate under their own terms; where a provider&rsquo;s
          consumer-tier terms permit training on submitted content, we treat that
          as a limitation to be closed rather than a permission we rely on, and we
          disclose the current state honestly in section 5.
        </p>
      </LegalSection>

      <LegalSection n={3} title="Privacy data matrix">
        <p>
          The table below lists every category of personal information the
          Command Center collects, why, and who receives it. Rows marked{" "}
          <strong>Sensitive</strong> are treated as sensitive personal information
          under Quebec Law 25 and the California Privacy Rights Act.
        </p>
        <div className="my-5 overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full min-w-[46rem] border-collapse text-left text-[13.5px]">
            <thead>
              <tr className="bg-white/[0.04] text-white/60">
                <th className="px-3 py-2.5 font-medium">Category</th>
                <th className="px-3 py-2.5 font-medium">Fields</th>
                <th className="px-3 py-2.5 font-medium">Purpose</th>
                <th className="px-3 py-2.5 font-medium">Shared with</th>
                <th className="px-3 py-2.5 font-medium">Retention</th>
              </tr>
            </thead>
            <tbody className="text-white/75">
              {DATA_MATRIX.map((row) => (
                <tr key={row.category} className="border-t border-white/10 align-top">
                  <td className="px-3 py-3">
                    <span className="font-medium text-white">{row.category}</span>
                    {row.sensitive ? (
                      <span className="mt-1.5 block w-fit rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-200/90">
                        Sensitive
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-white/60">{row.examples}</td>
                  <td className="px-3 py-3">{row.purpose}</td>
                  <td className="px-3 py-3 text-white/60">{row.sharedWith}</td>
                  <td className="px-3 py-3 text-white/60">{row.retention}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-white/55">
          A machine-readable version of this matrix is published at{" "}
          <code>docs/compliance/PRIVACY_NUTRITION_LABEL.json</code> in the product
          repository and is the source used for app-store privacy declarations.
        </p>
      </LegalSection>

      <LegalSection n={4} title="Analytics and tracking">
        <p>
          The Command Center does <strong>not</strong> load third-party analytics
          SDKs, advertising pixels, or cross-site trackers. There is no Google
          Analytics, Meta Pixel, PostHog, or similar tag in this application.
        </p>
        <p>
          We use strictly necessary cookies for authentication and session state,
          and our hosting provider records standard server logs (IP address,
          request path, timestamp, user agent) for security and debugging. If we
          add an analytics provider in future, this section and the data matrix
          above will be updated in the same release.
        </p>
      </LegalSection>

      <LegalSection n={5} title="Subprocessors">
        <p>
          We share personal information with the following processors. Each entry
          states whether a data processing agreement is currently in place for
          that specific data path.
        </p>
        <div className="my-5 overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full min-w-[44rem] border-collapse text-left text-[13.5px]">
            <thead>
              <tr className="bg-white/[0.04] text-white/60">
                <th className="px-3 py-2.5 font-medium">Processor</th>
                <th className="px-3 py-2.5 font-medium">Role</th>
                <th className="px-3 py-2.5 font-medium">Data received</th>
                <th className="px-3 py-2.5 font-medium">Region</th>
                <th className="px-3 py-2.5 font-medium">DPA</th>
              </tr>
            </thead>
            <tbody className="text-white/75">
              {SUBPROCESSORS.map((s) => (
                <tr key={s.name} className="border-t border-white/10 align-top">
                  <td className="px-3 py-3 font-medium text-white">{s.name}</td>
                  <td className="px-3 py-3">{s.role}</td>
                  <td className="px-3 py-3 text-white/60">{s.dataReceived}</td>
                  <td className="px-3 py-3 text-white/60">{s.region}</td>
                  <td className="px-3 py-3">
                    {s.dpaInPlace ? (
                      <span className="text-emerald-300/90">In place</span>
                    ) : (
                      <span className="text-amber-300/90">Under review</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </LegalSection>

      <LegalSection n={6} title="International transfers">
        <p>
          We are based in Quebec, Canada. Our hosting, database, and model
          providers are located in the United States, so your information is
          transferred outside Canada and outside the European Economic Area. Under
          Quebec Law 25 we are required to assess whether the destination
          jurisdiction provides adequate protection before transferring personal
          information outside the province; that assessment is in progress for the
          model-provider paths marked &ldquo;Under review&rdquo; above.
        </p>
      </LegalSection>

      <LegalSection n={7} title="Your rights">
        <p>
          Subject to your jurisdiction, you may request access to the personal
          information we hold about you, correction of inaccurate information,
          deletion, portability, withdrawal of consent, and — in Quebec — the
          de-indexing of information in certain circumstances. California
          residents may additionally opt out of any sale or sharing of personal
          information; we do not sell or share personal information as those terms
          are defined by the CPRA.
        </p>
        <p>
          Send requests to{" "}
          <a href={`mailto:${LEGAL_CONTACTS.privacy}`}>{LEGAL_CONTACTS.privacy}</a>.
          We respond within 30 days. We will not discriminate against you for
          exercising a privacy right.
        </p>
      </LegalSection>

      <LegalSection n={8} title="Security and breach notification">
        <p>
          Data is encrypted in transit and at rest. Access to tenant data is
          restricted by row-level security, and administrative access is limited
          to personnel who need it. No system is perfectly secure. If a
          confidentiality incident presents a risk of serious injury, we will
          notify affected individuals and the Commission d&rsquo;accès à
          l&rsquo;information du Québec as required by Law 25, and any other
          regulator required by applicable law.
        </p>
      </LegalSection>

      <LegalSection n={9} title="Children">
        <p>
          The Command Center is a business tool and is not directed to children.
          We do not knowingly collect personal information from anyone under 18.
        </p>
      </LegalSection>

      <LegalSection n={10} title="Changes">
        <p>
          We will post any change here and update the effective date. Material
          changes affecting how we share data with model providers will be
          communicated to account holders by email before taking effect.
        </p>
        <LegalCallout>
          This policy describes current engineering reality as verified on
          2026-07-27, including gaps that are still open. It has not yet been
          reviewed by counsel and is not a substitute for legal advice.
        </LegalCallout>
      </LegalSection>
    </LegalPage>
  );
}
