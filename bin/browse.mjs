#!/usr/bin/env node
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("Browse requires Node.js 24 or newer.");
  process.exit(1);
}
import("../src/cli.mjs")
  .then(({ main }) => main())
  .catch((error) => {
    console.error(`browse: ${error.message}`);
    process.exitCode = 1;
  });
