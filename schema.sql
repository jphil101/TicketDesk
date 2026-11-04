-- Created automatically on the first sync request. Kept here for reference or manual setup.

create table if not exists desks (
  desk text primary key,
  rev bigint not null default 0,
  created_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);

create table if not exists items (
  desk text not null references desks(desk) on delete cascade,
  kind text not null,
  id text not null,
  body jsonb,
  deleted boolean not null default false,
  updated_at bigint not null,
  rev bigint not null,
  primary key (desk, kind, id)
);

create index if not exists items_desk_rev on items (desk, rev);
