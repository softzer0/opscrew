<?php

declare(strict_types=1);

$config = require __DIR__ . '/../src/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
header('Content-Type: text/plain; charset=utf-8');

/** Answers with `status` and `text`, and stops. */
function answer(int $status, string $text): never
{
    http_response_code($status);
    echo $text;
    exit;
}

try {
    // `/cron` reads only the kept folder: how many times bin/cron.php ran.
    if ($method === 'GET' && $path === '/cron') {
        $runs = @file(STORAGE . '/cron.log', FILE_IGNORE_NEW_LINES) ?: [];
        if ($runs === []) {
            answer(404, 'The cron job has not run yet.');
        }
        answer(200, sprintf('The cron job ran %d times.', count($runs)));
    }

    $pdo = database($config);
    $pdo->exec('CREATE TABLE IF NOT EXISTS notes (name VARCHAR(64) PRIMARY KEY, body TEXT NOT NULL)');

    if ($method === 'GET' && $path === '/') {
        $version = $pdo->query('SELECT VERSION()')->fetchColumn();
        file_put_contents(STORAGE . '/visits.log', date('c') . "\n", FILE_APPEND | LOCK_EX);
        answer(200, sprintf("Notes at %s: MySQL %s answered.\n", $config['url'], $version));
    }

    // `/data` keeps one note twice: in MySQL and as a file in the kept folder.
    if ($method === 'PUT' && $path === '/data') {
        $body = (string) file_get_contents('php://input');
        $pdo->prepare('REPLACE INTO notes (name, body) VALUES (?, ?)')->execute(['data', $body]);
        file_put_contents(STORAGE . '/data.txt', $body, LOCK_EX);
        answer(204, '');
    }
    if ($method === 'GET' && $path === '/data') {
        $statement = $pdo->prepare('SELECT body FROM notes WHERE name = ?');
        $statement->execute(['data']);
        $body = $statement->fetchColumn();
        $file = @file_get_contents(STORAGE . '/data.txt');
        if ($body === false || $file === false) {
            answer(404, 'No note yet.');
        }
        if ($body !== $file) {
            answer(409, 'The note in MySQL and the one in storage/ differ.');
        }
        answer(200, $body);
    }

    answer(404, 'Not found.');
} catch (PDOException $error) {
    answer(503, 'The database is not reachable' . ($config['debug'] ? ': ' . $error->getMessage() : '.'));
}
