/**
 * The server-render half of tests/extracted-videos.test.ts.
 *
 * The suite runs with `--conditions=react-server`, under which react-dom/server
 * does not resolve, so the test spawns this file without that condition and
 * asserts on the markup it prints: components/founders/LazyVideo.tsx as the
 * server sends it, before any IntersectionObserver has run. It asserts nothing
 * itself.
 */

// A module, not a global script, so its `main` cannot collide under tsc.
export {};

async function main() {
  const React = await import("react");
  // tsconfig sets jsx:"preserve", so tsx compiles component JSX with the
  // classic runtime, which expects a global React.
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LazyVideo } = await import("../components/founders/LazyVideo");
  const markup = renderToStaticMarkup(
    React.createElement(LazyVideo, {
      src: "https://storage.example/signed/one.mp4?sig=x",
      width: 720,
      height: 1280,
      title: "Video by ccmusicc03",
    }),
  );
  process.stdout.write(JSON.stringify({ markup }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
