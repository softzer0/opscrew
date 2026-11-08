<?php

declare(strict_types=1);

file_put_contents(__DIR__ . '/../storage/cron.log', date('c') . "\n", FILE_APPEND);
