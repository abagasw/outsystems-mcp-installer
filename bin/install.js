#!/usr/bin/env node
import { installApplication } from "../src/install.js";

installApplication(process.argv[2]).then(({ directory }) => {
  console.log(`Installed into ${directory}`);
}).catch((error) => {
  console.error(`Installation failed: ${error.message}`);
  process.exitCode = 1;
});
