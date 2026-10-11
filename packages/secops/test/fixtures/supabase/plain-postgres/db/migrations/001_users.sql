create table users (
  id serial primary key,
  email text not null,
  password_hash text not null
);
