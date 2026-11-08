<?php

declare(strict_types=1);

// The host runs this every minute; it records each run in the kept folder.
require __DIR__ . '/../src/bootstrap.php';

file_put_contents(STORAGE . '/cron.log', date('c') . "\n", FILE_APPEND | LOCK_EX);
