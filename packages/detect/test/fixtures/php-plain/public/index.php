<?php

declare(strict_types=1);

$config = require __DIR__ . '/../config/settings.php';

$pdo = new PDO(
    sprintf('mysql:host=%s;port=%d;dbname=%s', $config['db']['host'], $config['db']['port'], $config['db']['name']),
    $config['db']['user'],
    $config['db']['password'],
);

file_put_contents(__DIR__ . '/../storage/visits.log', date('c') . "\n", FILE_APPEND);

echo 'Guestbook: ' . $pdo->query('SELECT COUNT(*) FROM entries')->fetchColumn() . ' entries';
