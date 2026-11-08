<?php

declare(strict_types=1);

$settings = new Guestbook\Settings();

return [
    'env' => $settings->string("APP_ENV", 'production'),
    'url' => getenv('APP_URL'),
    'log_level' => env('LOG_LEVEL', "info"),
    // Not in .env.example: PHP code adds no variable of its own.
    'debug' => getenv('FEATURE_DEBUG') ?: 'off',
    'db' => [
        'host' => getenv('DB_HOST') ?: '127.0.0.1',
        'port' => (int) ($_ENV["DB_PORT"] ?? 3306),
        'name' => $_SERVER['DB_DATABASE'] ?? 'guestbook',
        'user' => getenv('DB_USERNAME'),
        'password' => $_ENV['DB_PASSWORD'] ?? '',
    ],
];
