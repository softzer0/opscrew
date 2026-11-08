# Plain PHP + MySQL (OpsCrew example)

A notes page in plain PHP, without a framework, as made for shared hosting: `public/index.php`
answers `/` after a query to MySQL through `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` and
`DB_PASSWORD`, and writes a line to `storage/visits.log`. `PUT /data` and `GET /data` keep a note
in MySQL and in `storage/data.txt`; `bin/cron.php`, run every minute, records its runs in
`storage/cron.log`, and `GET /cron` counts them. `storage/` holds a `.htaccess` that denies it to
the web.
