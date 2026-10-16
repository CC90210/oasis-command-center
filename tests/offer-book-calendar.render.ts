/**
 * Spawned by tests/offer-book-calendar.test.ts as a PLAIN node process
 * (FormPublicClient is a client component and cannot render under
 * --conditions=react-server; same reason as tests/offer-community-link.render.ts).
 *
 * Renders the form's LAST screen (resumeBooking opens there) for each kind of
 * form, and prints one JSON object { case: markup }.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { FormPublicClient } from "../components/forms/FormPublicClient";

type Props = Parameters<typeof FormPublicClient>[0];
const base = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "fixtures", "offer-pages", "form-only.props.json"), "utf8"),
) as Props;

const THANKS = "Thanks, we have your pick. A member of the OASIS team will email you a secure checkout link.";
// The visitor's answers reach the last screen as `prefill` here (a static
// render cannot type into the form); the fixture's phone field is "phone".
const PHONE = { phone: "+1 514 555 0101" };
const lastScreen = (tenantSlug: string, formSlug: string, answers: Record<string, unknown> | null = PHONE) =>
  renderToStaticMarkup(
    React.createElement(FormPublicClient, {
      ...base,
      branding: { ...base.branding, thanks_message: THANKS },
      tenantSlug,
      formSlug,
      resumeBooking: true,
      prefill: answers,
    }),
  );

console.log(
  JSON.stringify({
    protocol: lastScreen("oasis-ai-cc", "protocol"),
    community: lastScreen("oasis-ai-cc", "community"),
    protocolNoPhone: lastScreen("oasis-ai-cc", "protocol", { phone: "  " }),
    protocolBadPhone: lastScreen("oasis-ai-cc", "protocol", { phone: "123" }),
    communityNoAnswers: lastScreen("oasis-ai-cc", "community", null),
    command: lastScreen("oasis-ai-cc", "command"),
    vsl: lastScreen("oasis-ai-cc", "vsl"),
    otherWorkspace: lastScreen("other-co", "protocol"),
  }),
);
