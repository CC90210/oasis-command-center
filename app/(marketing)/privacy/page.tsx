import type { Metadata } from "next";
import { LegalPage, LegalSection, LegalCallout } from "@/components/legal/LegalPage";
import {
  DATA_MATRIX,
  SUBPROCESSORS,
  LEGAL_CONTACTS,
  LEGAL_ENTITY,
  LEGAL_PRINCIPAL_PLACE,
  PRIVACY_LAST_UPDATED,
  PRIVACY_OFFICER,
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
      <div className="mb-9 space-y-1.5">
        <p className="font-data text-[11px] uppercase tracking-[0.18em] text-fg-dim">
          Last updated {PRIVACY_LAST_UPDATED}
        </p>
        <p className="text-[13.5px] leading-relaxed text-fg-dim">
          A French version of this policy is in preparation.{" "}
          <span lang="fr">
            Une version française de la présente politique est en préparation.
          </span>
        </p>
      </div>

      <LegalSection n={1} title="Who we are">
        <p>
          {LEGAL_ENTITY} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) operates the OASIS
          Agent Command Center at oasisai.work. Our principal place of business is{" "}
          {LEGAL_PRINCIPAL_PLACE}. For privacy questions, or to exercise any right
          described below, contact our person in charge of the protection of
          personal information (section 2) at{" "}
          <a href={`mailto:${LEGAL_CONTACTS.privacy}`}>{LEGAL_CONTACTS.privacy}</a>.
        </p>
        <p>
          The Command Center is a multi-tenant product. Where you submit
          information through a form published by one of our customers (a
          &ldquo;tenant&rdquo;), that tenant is the controller of your
          information and we process it on their behalf as a service provider.
        </p>
      </LegalSection>

      <LegalSection n={2} title="Person in charge of the protection of personal information">
        <p>
          Under Quebec&rsquo;s{" "}
          <em>Act respecting the protection of personal information in the private
          sector</em> (Law 25), {LEGAL_ENTITY} has designated a person in charge of
          the protection of personal information. That person is responsible for
          ensuring we comply with the Act, and handles requests to access, correct,
          or delete personal information and complaints about how we handle it.
        </p>
        <p>
          <strong>{PRIVACY_OFFICER.name}</strong>
          <br />
          {PRIVACY_OFFICER.title.en}{" "}
          <span lang="fr">({PRIVACY_OFFICER.title.fr})</span>
          <br />
          {LEGAL_ENTITY}, {LEGAL_PRINCIPAL_PLACE}
          <br />
          <a href={`mailto:${PRIVACY_OFFICER.email}`}>{PRIVACY_OFFICER.email}</a>
        </p>
        <p>
          If you are not satisfied with our response, you may file a complaint with
          the Commission d&rsquo;accès à l&rsquo;information du Québec.
        </p>
      </LegalSection>

      <LegalSection n={3} title="AI data processing and machine learning">
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
          Depending on the task and how a workspace is configured, content may be
          sent to Anthropic PBC (Claude), OpenAI, L.L.C. (GPT), Google LLC
          (Gemini), or OpenRouter, which forwards a request to the provider hosting
          the model the workspace selects. These providers are based in the United
          States. The full subprocessor list, and what each one receives, is in
          section 6.
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
          If you are in Quebec, you have the right under Law 25 to be informed when
          a decision about you is based exclusively on automated processing, and to
          submit observations to a human. Write to{" "}
          <a href={`mailto:${LEGAL_CONTACTS.privacy}`}>{LEGAL_CONTACTS.privacy}</a>{" "}
          to exercise that right.
        </p>

        <h3>Training</h3>
        <p>
          We do not train our own models on your data. We do not sell your data.
          Model providers operate under their own terms; where a provider&rsquo;s
          consumer-tier terms permit training on submitted content, we treat that
          as a limitation to be closed rather than a permission we rely on, and we
          disclose the current state honestly in section 6.
        </p>
      </LegalSection>

      <LegalSection n={4} title="Privacy data matrix">
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
          A machine-readable copy of this matrix is kept in the product repository
          at <code>docs/compliance/PRIVACY_NUTRITION_LABEL.json</code> and is the
          source used for app-store privacy declarations.
        </p>
      </LegalSection>

      <LegalSection n={5} title="Analytics and tracking">
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

      <LegalSection n={6} title="Subprocessors">
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
                  <td className="px-3 py-3">
                    <span className="font-medium text-white">{s.name}</span>
                    {s.note ? (
                      <span className="mt-1.5 block text-[12.5px] leading-snug text-white/55">
                        {s.note}
                      </span>
                    ) : null}
                  </td>
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
        <p>
          <strong>Former database provider.</strong> Records created before we
          moved our database to Turso in August 2026 also remain in a legacy
          database hosted by Supabase, Inc. in the United States. The application
          no longer uses that database, and we plan to delete it.
        </p>
      </LegalSection>

      <LegalSection n={7} title="International transfers">
        <p>
          We are based in Quebec, Canada. Our database and most of our processors
          are located in the United States, and our application runs on
          Cloudflare&rsquo;s global network; section 6 lists each
          processor&rsquo;s region. Your information is therefore transferred
          outside Quebec, and in most cases outside Canada. Under Quebec Law 25 we
          are required to assess whether the destination jurisdiction provides
          adequate protection before transferring personal information outside
          the province; that assessment is in progress for the processors marked
          &ldquo;Under review&rdquo; above.
        </p>
      </LegalSection>

      <LegalSection n={8} title="Your rights">
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
          Send requests to our person in charge of the protection of personal
          information at{" "}
          <a href={`mailto:${LEGAL_CONTACTS.privacy}`}>{LEGAL_CONTACTS.privacy}</a>.
          We respond within 30 days. We will not discriminate against you for
          exercising a privacy right.
        </p>
      </LegalSection>

      <LegalSection n={9} title="Security and breach notification">
        <p>
          Data is encrypted in transit between your browser, our application, and
          our processors. Credentials you connect to the service — AI provider
          API keys, email account passwords, and OAuth tokens — are encrypted by
          our application with AES-256-GCM before they are stored. Uploaded
          documents are kept in private Cloudflare R2 storage, which encrypts
          stored objects, and are served only through short-lived signed links.
          Other database fields, including the categories marked Sensitive in
          section 4, are not separately encrypted by our application.
        </p>
        <p>
          All customers&rsquo; workspaces share one database. Customer records are
          tagged with the workspace they belong to, and our application limits its
          queries to the workspace of the signed-in user. This separation is
          enforced by our application code; the database itself does not enforce
          per-customer access rules. OASIS staff who operate the service can
          access customer workspaces to provide support and keep the service
          running.
        </p>
        <p>
          Changes to team membership and access, AI provider settings, automation
          controls, and e-signature events are recorded in a per-workspace audit
          log.
        </p>
        <p>
          No system is perfectly secure. If a confidentiality incident presents a
          risk of serious injury, we will notify affected individuals and the
          Commission d&rsquo;accès à l&rsquo;information du Québec as required by
          Law 25, and any other regulator required by applicable law.
        </p>
      </LegalSection>

      <LegalSection n={10} title="Children">
        <p>
          The Command Center is a business tool and is not directed to children.
          We do not knowingly collect personal information from anyone under 18.
        </p>
      </LegalSection>

      <LegalSection n={11} title="Changes">
        <p>
          We will post any change here and update the &ldquo;last updated&rdquo;
          date at the top of this policy. Material changes affecting how we share
          data with model providers will be communicated to account holders by
          email before taking effect.
        </p>
        <LegalCallout>
          This policy describes current engineering reality as verified on{" "}
          {PRIVACY_LAST_UPDATED}, including gaps that are still open. It has not
          yet been reviewed by counsel and is not a substitute for legal advice.
        </LegalCallout>
      </LegalSection>
    </LegalPage>
  );
}
