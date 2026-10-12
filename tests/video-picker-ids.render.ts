/**
 * The server-render half of tests/video-picker-ids.test.ts.
 *
 * The suite runs with `--conditions=react-server`, under which react-dom/server
 * does not resolve, so the test spawns this file without that condition and
 * reads the markup it prints. It asserts nothing itself.
 */

export {};

async function main() {
  const React = await import("react");
  // tsconfig sets jsx:"preserve", so tsx compiles component JSX with the
  // classic runtime, which expects a global React.
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { VideoPicker } = await import("../components/offer-pages/builder/VideoPicker");

  // Two siblings in ONE tree, the exact shape a repeated per-item picker
  // (WhatYouGetItems' per-item demo video) renders: React's useId() assigns
  // each a position-based id, distinct from its sibling's, UNLIKE the fixed
  // string ids this file's test exists to catch a regression of.
  const markup = renderToStaticMarkup(
    React.createElement(
      "div",
      null,
      React.createElement(VideoPicker, { formId: "f-1", value: null, onChange: () => undefined, libraryAvailable: false, label: "Item 1 video" }),
      React.createElement(VideoPicker, { formId: "f-1", value: null, onChange: () => undefined, libraryAvailable: false, label: "Item 2 video" }),
    ),
  );
  process.stdout.write(JSON.stringify({ markup }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
