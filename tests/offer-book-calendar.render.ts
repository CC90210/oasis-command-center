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
const lastScreen = (tenantSlug: string, formSlug: string) =>
  renderToStaticMarkup(
    React.createElement(FormPublicClient, {
      ...base,
      branding: { ...base.branding, thanks_message: THANKS },
      tenantSlug,
      formSlug,
      resumeBooking: true,
    }),
  );

console.log(
  JSON.stringify({
    protocol: lastScreen("oasis-ai-cc", "protocol"),
    community: lastScreen("oasis-ai-cc", "community"),
    command: lastScreen("oasis-ai-cc", "command"),
    vsl: lastScreen("oasis-ai-cc", "vsl"),
    otherWorkspace: lastScreen("other-co", "protocol"),
  }),
);
