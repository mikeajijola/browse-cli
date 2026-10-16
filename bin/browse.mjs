#!/usr/bin/env node
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("Browse requires Node.js 24 or newer.");
  process.exit(1);
}
import("../src/frontend.mjs")
  .then(async ({ frontendRoute, runFrontend }) => {
    const route = frontendRoute(process.argv.slice(2));
    if (route.native) return runFrontend(route.args, { home: route.home });
    return (await import("../src/cli.mjs")).main(route.args);
  })
  .catch((error) => {
    console.error(`browse: ${error.message}`);
    process.exitCode = 1;
  });
