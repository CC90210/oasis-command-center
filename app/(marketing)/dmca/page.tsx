import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection, LegalCallout } from "@/components/legal/LegalPage";
import { LEGAL_CONTACTS, LEGAL_ENTITY } from "@/lib/legal/constants";

export const metadata: Metadata = {
  title: "DMCA & Copyright Notices",
  description:
    "How to submit a DMCA takedown notice or counter-notice to OASIS AI Solutions, including the designated agent contact.",
};

const NOTICE_TEMPLATE = `To: ${LEGAL_CONTACTS.dmca}
Subject: DMCA Takedown Notice

1. Copyrighted work: [describe the work, or list works if multiple]
2. Infringing material and its location: [URL or precise description]
3. My contact information: [name, mailing address, phone, email]
4. I have a good faith belief that use of the material described above is not
   authorized by the copyright owner, its agent, or the law.
5. I swear, under penalty of perjury, that the information in this notification
   is accurate and that I am the copyright owner, or am authorized to act on
   behalf of the owner, of an exclusive right that is allegedly infringed.

Signature: [physical or electronic signature]
Date: [date]`;

export default function DmcaPage() {
  return (
    <LegalPage
      title="Copyright & DMCA Notices"
      subtitle={`How to report allegedly infringing material hosted by ${LEGAL_ENTITY}, and how to respond if your content was removed.`}
    >
      <LegalSection n={1} title="Designated agent">
        <p>Send all copyright notices to our designated agent:</p>
        <div className="my-4 rounded-lg border border-white/10 bg-white/[0.03] p-4 text-[14.5px]">
          <div className="text-white">Copyright Agent, {LEGAL_ENTITY}</div>
          <div className="mt-1 text-white/65">
            <a href={`mailto:${LEGAL_CONTACTS.dmca}`}>{LEGAL_CONTACTS.dmca}</a>
          </div>
          <div className="mt-1 text-white/50">Montreal, Quebec, Canada</div>
        </div>
        <p className="text-white/55">
          Notices sent to any other address may not receive a timely response.
        </p>
      </LegalSection>

      <LegalSection n={2} title="What a valid notice must contain">
        <p>
          To be effective under 17 U.S.C. § 512(c)(3), your notice must include
          all six elements below. Incomplete notices cannot be acted on.
        </p>
        <ol>
          <li>A physical or electronic signature.</li>
          <li>Identification of the copyrighted work you say was infringed.</li>
          <li>
            Identification of the material you say is infringing, specific enough
            that we can find it.
          </li>
          <li>Your name, address, telephone number, and email.</li>
          <li>
            A statement that you have a good faith belief the use is not
            authorised by the owner, its agent, or the law.
          </li>
          <li>
            A statement, under penalty of perjury, that your notice is accurate
            and that you are the owner or authorised to act for the owner.
          </li>
        </ol>

        <h3>Copy-and-paste template</h3>
        <pre className="my-3 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-4 text-[12.5px] leading-relaxed text-white/70">
          {NOTICE_TEMPLATE}
        </pre>
        <p>
          <a
            href={`mailto:${LEGAL_CONTACTS.dmca}?subject=${encodeURIComponent(
              "DMCA Takedown Notice",
            )}`}
            className="inline-block rounded-md border border-white/20 bg-white/[0.06] px-4 py-2 !text-white !no-underline hover:bg-white/10"
          >
            Email the copyright agent
          </a>
        </p>
      </LegalSection>

      <LegalSection n={3} title="Counter-notice">
        <p>
          If your material was removed and you believe that was a mistake or
          misidentification, you may send a counter-notice under 17 U.S.C.
          § 512(g) to the same address. It must include your signature,
          identification of the removed material and where it appeared, a
          statement under penalty of perjury that you have a good faith belief the
          removal resulted from mistake or misidentification, and your consent to
          the jurisdiction of the appropriate court.
        </p>
        <p>
          We may restore the material 10 to 14 business days after we forward a
          valid counter-notice, unless the original complainant notifies us that
          they have filed a court action.
        </p>
      </LegalSection>

      <LegalSection n={4} title="Canadian notice-and-notice">
        <p>
          We operate from Canada. For content associated with Canadian users, the
          notice-and-notice regime in sections 41.25 to 41.27 of the{" "}
          <em>Copyright Act</em> (Canada) applies. Under that regime we forward a
          compliant notice to the affected user and retain records; Canadian law
          does not require us to remove the content on receipt of a notice alone.
        </p>
      </LegalSection>

      <LegalSection n={5} title="Repeat infringers and misrepresentation">
        <p>
          We terminate accounts of repeat infringers in appropriate circumstances.
          Under 17 U.S.C. § 512(f), knowingly misrepresenting that material is
          infringing can make you liable for damages, including costs and
          attorneys&rsquo; fees.
        </p>
        <p>
          Our full copyright policy is in section 8 of the{" "}
          <Link href="/terms">Terms of Service</Link>.
        </p>
        <LegalCallout>
          Safe harbour under 17 U.S.C. § 512 requires a Designated Agent
          registered with the U.S. Copyright Office. That registration is pending
          — see the deployment SOP in the operations repository. Until it is
          filed, this policy describes our practice but does not by itself
          establish the statutory safe harbour.
        </LegalCallout>
      </LegalSection>
    </LegalPage>
  );
}
