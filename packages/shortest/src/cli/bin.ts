#!/usr/bin/env node
import pc from "picocolors";
import { GitHubTool } from "@/browser/integrations/github";
import {
  purgeLegacyCache,
  cleanUpCache,
  purgeLegacyScreenshots,
} from "@/cache";
import { ENV_LOCAL_FILENAME } from "@/constants";
import { TestRunner } from "@/core/runner";
import { getConfig, initializeConfig } from "@/index";
import { LogLevel } from "@/log/config";
import { getLogger } from "@/log/index";
import { CLIOptions } from "@/types";
import { getErrorDetails, ShortestError } from "@/utils/errors";

process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (
    warning.name === "DeprecationWarning" &&
    warning.message.includes("punycode")
  ) {
    return;
  }
  console.warn(warning);
});

const VALID_FLAGS = [
  "--debug-ai",
  "--github-code",
  "--headless",
  "--help",
  "--log-enabled",
  "--no-cache",
  "--no-legacy-output",
  "--force-purge",
  "-h",
];
const VALID_PARAMS = ["--target", "--secret", "--log-level"];

const showHelp = () => {
  console.log(`
${pc.bold("Shortest")} - AI-powered end-to-end testing framework
${pc.dim("https://github.com/antiwork/shortest")}

${pc.bold("Usage:")}
  $ shortest [options] [pattern]                  Run tests matching pattern (default: **/*.test.ts)
  $ shortest init                                 Initialize Shortest in current directory
  $ shortest cache clear [--force-purge]          Clear test cache

${pc.bold("Options:")}
  --headless                                      Run tests in headless browser mode
  --target=<url>                                  Set target URL for tests (default: http://localhost:3000)
  --no-cache                                      Disable test action caching
  --log-level=<level>                             Set logging level [silent|error|warn|info|debug|trace] (default: silent)
  --github-code                                   Generate GitHub 2FA code for authentication
  --secret=<key>                                  GitHub TOTP secret key (can also be set in ${ENV_LOCAL_FILENAME})

${pc.bold("Environment setup:")}
  Required in ${ENV_LOCAL_FILENAME}:
    AI authentication
      SHORTEST_ANTHROPIC_API_KEY                  Anthropic API key for AI test execution
      ANTHROPIC_API_KEY                           Alternative Anthropic API key (only one is required)

    GitHub authentication
      GITHUB_TOTP_SECRET                          GitHub 2FA secret
      GITHUB_USERNAME                             GitHub username
      GITHUB_PASSWORD                             GitHub password

${pc.bold("Examples:")}
  shortest                                        # Run all tests
  shortest login.test.ts                          # Run a single test file
  shortest --headless                             # Run in headless browser mode
  shortest --github-code --secret=<OTP_SECRET>    # Generate GitHub 2FA code

${pc.bold("Documentation:")}
  ${pc.cyan("https://github.com/antiwork/shortest")}
`);
};

const handleGitHubCode = async (args: string[]) => {
  try {
    const secret = args
      .find((arg) => arg.startsWith("--secret="))
      ?.split("=")[1];
    const github = new GitHubTool(secret);
    const { code, timeRemaining } = github.generateTOTPCode();

    console.log("\n" + pc.bgCyan(pc.black(" GitHub 2FA Code ")));
    console.log(pc.cyan("Code: ") + pc.bold(code));
    console.log(pc.cyan("Expires in: ") + pc.bold(`${timeRemaining}s`));
    console.log(
      pc.dim(`Using secret from: ${secret ? "CLI flag" : ".env file"}\n`),
    );

    process.exit(0);
  } catch (error) {
    console.error(pc.red("\n✖ Error:"), (error as Error).message, "\n");
    process.exit(1);
  }
};

const isValidArg = (arg: string): boolean => {
  if (VALID_FLAGS.includes(arg)) {
    return true;
  }

  // Check if it's a parameter with value
  const paramName = arg.split("=")[0];
  if (VALID_PARAMS.includes(paramName)) {
    return true;
  }

  return false;
};

const getParamValue = (
  args: string[],
  paramName: string,
): string | undefined => {
  const param = args.find((arg) => arg.startsWith(paramName));
  if (param) {
    return param.split("=")[1];
  }
  return undefined;
};

const main = async () => {
  const args = process.argv.slice(2);
  const logLevel = getParamValue(args, "--log-level");
  const log = getLogger({
    level: logLevel as LogLevel,
  });

  const debugAI = args.includes("--debug-ai");
  if (debugAI) {
    log.config.level = "debug";
    log.warn("--debug-ai is deprecated, use --log-level=debug instead");
  }

  log.trace("Starting Shortest CLI", { args: process.argv });
  log.trace("Log config", { ...log.config });

  if (args[0] === "init") {
    await require("./init").default();
    process.exit(0);
  }

  if (args[0] === "cache") {
    if (args[1] === "clear") {
      const forcePurge = args.includes("--force-purge");
      await cleanUpCache({ forcePurge });
      process.exit(0);
    }
    console.error("Invalid cache command. Use 'shortest cache clear'");
    process.exit(1);
  }

  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  if (args.includes("--github-code")) {
    log.trace("Handling GitHub code argument");
    await handleGitHubCode(args);
  }

  const invalidFlags = args
    .filter((arg) => arg.startsWith("--"))
    .filter((arg) => !isValidArg(arg));

  if (invalidFlags.length > 0) {
    console.error(pc.red("Invalid argument(s)"), { invalidFlags });
    process.exit(1);
  }

  const headless = args.includes("--headless");
  const baseUrl = args
    .find((arg) => arg.startsWith("--target="))
    ?.split("=")[1];
  let testPattern = args.find((arg) => !arg.startsWith("--"));
  const noCache = args.includes("--no-cache");
  let lineNumber: number | undefined;

  if (testPattern?.includes(":")) {
    const [file, line] = testPattern.split(":");
    testPattern = file;
    lineNumber = parseInt(line, 10);
  }

  const cliOptions: CLIOptions = {
    headless,
    baseUrl,
    testPattern,
    noCache,
  };
  log.trace("Initializing config with CLI options", { cliOptions });
  await initializeConfig({ cliOptions });
  const config = getConfig();

  await purgeLegacyCache();
  await purgeLegacyScreenshots();

  try {
    log.trace("Initializing TestRunner");
    const runner = new TestRunner(process.cwd(), config);
    await runner.initialize();
    const success = await runner.execute(
      testPattern ?? config.testPattern,
      lineNumber,
    );
    process.exitCode = success ? 0 : 1;
  } catch (error: any) {
    log.trace("Handling error for TestRunner");
    if (!(error instanceof ShortestError)) throw error;

    console.error(pc.red(error.name));
    console.error(error.message, getErrorDetails(error));
    process.exitCode = 1;
  } finally {
    await cleanUpCache();
  }
  process.exit();
};

main().catch(async (error) => {
  const log = getLogger();
  log.trace("Handling error on main()");
  if (!(error instanceof ShortestError)) throw error;

  console.error(pc.red(error.name), error.message);
  process.exit(1);
});
