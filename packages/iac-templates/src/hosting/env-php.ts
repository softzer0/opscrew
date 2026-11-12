import { OpsCrewError } from "@opscrew/core";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `shared/env.php` of a plain PHP app on a hosting account (027 plan 5), which PHP runs before each
 * request and cron job (`auto_prepend_file`). Valid PHP 7.0, defining nothing global. It loads the
 * values of `names` from the 0600 file `.env` beside it into `getenv()`, `$_ENV` and `$_SERVER`,
 * read as a dotenv file has them: `NAME=value` lines, a value bare, in single quotes (as is) or in
 * double quotes with `\\`, `\"`, `\n`, `\r`, `\t` and `\$` escapes; other lines are skipped. When
 * the file is missing or unreadable it answers 500 without printing anything (exit code 1 in a
 * cron job).
 *
 * @throws OpsCrewError `INVALID_INPUT` for a name that isn't an environment variable's, or twice.
 */
export function renderEnvPhp(names: readonly string[]): string {
  const bad = names.find((name, i) => !NAME.test(name) || names.indexOf(name) !== i);
  if (bad !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `env.php can't load ${JSON.stringify(bad)}: each name must be a distinct environment variable's (letters, digits and _, not first a digit).`,
    );
  }
  const listed = names.map((name) => `        '${name}' => true,`).join("\n");
  return String.raw`<?php
// OpsCrew: loads this app's settings from .env beside this file (0600) into getenv(), $_ENV and
// $_SERVER, before each request and cron job (auto_prepend_file). Rendered by OpsCrew; no value in it.
(function () {
    $file = __DIR__ . '/.env';
    $lines = is_readable($file) ? file($file, FILE_IGNORE_NEW_LINES) : false;
    if ($lines === false) {
        http_response_code(500);
        exit(1);
    }
    $names = array(
${listed}
    );
    foreach ($lines as $line) {
        if (!preg_match('/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s', rtrim($line, "\r"), $match) || !isset($names[$match[1]])) {
            continue;
        }
        $value = $match[2];
        $length = strlen($value);
        if ($length >= 2 && $value[0] === '"' && $value[$length - 1] === '"') {
            $value = strtr(substr($value, 1, -1), array('\\\\' => '\\', '\\"' => '"', '\\n' => "\n", '\\r' => "\r", '\\t' => "\t", '\\$' => '$'));
        } elseif ($length >= 2 && $value[0] === "'" && $value[$length - 1] === "'") {
            $value = substr($value, 1, -1);
        }
        putenv($match[1] . '=' . $value);
        $_ENV[$match[1]] = $value;
        $_SERVER[$match[1]] = $value;
    }
})();
`;
}
