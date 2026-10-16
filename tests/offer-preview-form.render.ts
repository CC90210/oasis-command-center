/**
 * Spawned by tests/offer-preview-form.test.ts as a PLAIN node process
 * (FormPublicClient is a client component and cannot render under
 * --conditions=react-server; same reason as tests/offer-community-link.render.ts).
 *
 * Renders a step holding an address field and a required multi-file upload,
 * in the owner's preview and live, and prints one JSON object { case: markup }.
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

const steps = [
  {
    key: "docs",
    title: "Your business",
    fields: [
      { name: "business_address", label: "Business address", type: "address", required: true },
      { name: "statements", label: "Bank statements", type: "file_upload_multi", required: true },
    ],
  },
] as unknown as Props["steps"];

const render = (preview: boolean) =>
  renderToStaticMarkup(
    React.createElement(FormPublicClient, {
      ...base,
      steps,
      ...(preview ? { preview: true, anonymousInit: undefined } : {}),
    }),
  );

console.log(JSON.stringify({ preview: render(true), live: render(false) }));
