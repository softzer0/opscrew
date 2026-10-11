import { main } from "./program";

// The `#!/usr/bin/env node` line is added by the tsup banner.
process.exitCode = await main(process.argv);
