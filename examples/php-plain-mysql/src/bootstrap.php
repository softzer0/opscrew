<?php

declare(strict_types=1);

// The settings come from the environment, with the defaults of a local MySQL.
$config = [
    'url' => getenv('APP_URL') ?: 'http://localhost:8080',
    'env' => getenv('APP_ENV') ?: 'production',
    'debug' => (getenv('APP_DEBUG') ?: 'false') === 'true',
    'db' => [
        'host' => getenv('DB_HOST') ?: '127.0.0.1',
        'port' => (int) (getenv('DB_PORT') ?: 3306),
        'name' => getenv('DB_DATABASE') ?: 'notes',
        'user' => getenv('DB_USERNAME') ?: 'notes',
        'password' => getenv('DB_PASSWORD') ?: '',
    ],
];

/** The folder the app writes to and keeps across deploys. */
const STORAGE = __DIR__ . '/../storage';

function database(array $config): PDO
{
    $db = $config['db'];
    return new PDO(
        sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $db['host'], $db['port'], $db['name']),
        $db['user'],
        $db['password'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5],
    );
}

return $config;
