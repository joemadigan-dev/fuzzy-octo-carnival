-- Enable extensions
create extension if not exists "uuid-ossp";

-- Enum types
create type public.decision_type as enum (
  'career', 'investment', 'business', 'hiring',
  'product', 'personal', 'legal_regulatory', 'other'
);

create type public.decision_status as enum (
  'draft', 'open', 'briefing_ready', 'closed', 'archived'
);

create type public.invite_status as enum (
  'pending', 'opened', 'submitted', 'expired'
);

create type public.recommendation_type as enum (
  'strongly_yes', 'lean_yes', 'uncertain', 'lean_no', 'strongly_no'
);

create type public.advice_style_type as enum (
  'supportive', 'challenging', 'pragmatic', 'risk_focused', 'commercial', 'personal'
);

-- Users table (extends Supabase auth)
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

-- Decisions table
create table public.decisions (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  question text not null,
  context text,
  decision_type public.decision_type not null,
  deadline date,
  status public.decision_status default 'open' not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  closed_at timestamptz,
  final_decision text,
  share_summary_enabled boolean default false not null
);

-- Advisers table
create table public.advisers (
  id uuid primary key default uuid_generate_v4(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  name text,
  email text,
  role_label text,
  invite_token text unique not null,
  invite_status public.invite_status default 'pending' not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  submitted_at timestamptz
);

create index advisers_invite_token_idx on public.advisers(invite_token);
create index advisers_decision_id_idx on public.advisers(decision_id);

-- Responses table
create table public.responses (
  id uuid primary key default uuid_generate_v4(),
  adviser_id uuid not null references public.advisers(id) on delete cascade,
  decision_id uuid not null references public.decisions(id) on delete cascade,
  recommendation public.recommendation_type not null,
  reasoning text not null,
  underestimated_risk text not null,
  change_mind_condition text not null,
  confidence_score integer not null check (confidence_score >= 1 and confidence_score <= 10),
  recommended_next_step text,
  advice_style public.advice_style_type,
  submitted_at timestamptz default now() not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index responses_decision_id_idx on public.responses(decision_id);
create index responses_adviser_id_idx on public.responses(adviser_id);

-- Decision briefs table
create table public.decision_briefs (
  id uuid primary key default uuid_generate_v4(),
  decision_id uuid not null references public.decisions(id) on delete cascade,
  version integer default 1 not null,
  model_provider text,
  model_name text,
  prompt_version text,
  executive_summary text,
  consensus_view text,
  recommendation_split jsonb,
  reasons_to_proceed jsonb,
  reasons_to_pause jsonb,
  underestimated_risks jsonb,
  change_mind_factors jsonb,
  confidence_analysis text,
  recommended_next_step text,
  suggested_decision text,
  caveats text,
  questions_to_ask jsonb,
  full_brief_markdown text,
  created_at timestamptz default now() not null
);

create index briefs_decision_id_idx on public.decision_briefs(decision_id);

-- Viral events table
create table public.viral_events (
  id uuid primary key default uuid_generate_v4(),
  source_decision_id uuid references public.decisions(id) on delete set null,
  source_adviser_id uuid references public.advisers(id) on delete set null,
  event_type text not null,
  created_at timestamptz default now() not null,
  metadata jsonb
);

-- Updated_at trigger function
create or replace function public.update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger update_users_updated_at before update on public.users
  for each row execute function public.update_updated_at_column();
create trigger update_decisions_updated_at before update on public.decisions
  for each row execute function public.update_updated_at_column();
create trigger update_advisers_updated_at before update on public.advisers
  for each row execute function public.update_updated_at_column();
create trigger update_responses_updated_at before update on public.responses
  for each row execute function public.update_updated_at_column();

-- Auto-create user profile on sign up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, email, full_name)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name'
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- RLS Policies

-- Users
alter table public.users enable row level security;
create policy "Users can view own profile" on public.users
  for select using (auth.uid() = id);
create policy "Users can update own profile" on public.users
  for update using (auth.uid() = id);
create policy "Service role can manage users" on public.users
  using (true);

-- Decisions
alter table public.decisions enable row level security;
create policy "Owners can view own decisions" on public.decisions
  for select using (auth.uid() = owner_id);
create policy "Owners can insert decisions" on public.decisions
  for insert with check (auth.uid() = owner_id);
create policy "Owners can update own decisions" on public.decisions
  for update using (auth.uid() = owner_id);
create policy "Owners can delete own decisions" on public.decisions
  for delete using (auth.uid() = owner_id);

-- Advisers
alter table public.advisers enable row level security;
create policy "Owners can view advisers" on public.advisers
  for select using (
    exists (
      select 1 from public.decisions
      where decisions.id = advisers.decision_id
      and decisions.owner_id = auth.uid()
    )
  );
create policy "Owners can insert advisers" on public.advisers
  for insert with check (
    exists (
      select 1 from public.decisions
      where decisions.id = decision_id
      and decisions.owner_id = auth.uid()
    )
  );
create policy "Owners can update advisers" on public.advisers
  for update using (
    exists (
      select 1 from public.decisions
      where decisions.id = advisers.decision_id
      and decisions.owner_id = auth.uid()
    )
  );

-- Responses
alter table public.responses enable row level security;
create policy "Owners can view responses for their decisions" on public.responses
  for select using (
    exists (
      select 1 from public.decisions
      where decisions.id = responses.decision_id
      and decisions.owner_id = auth.uid()
    )
  );

-- Decision briefs
alter table public.decision_briefs enable row level security;
create policy "Owners can view their decision briefs" on public.decision_briefs
  for select using (
    exists (
      select 1 from public.decisions
      where decisions.id = decision_briefs.decision_id
      and decisions.owner_id = auth.uid()
    )
  );

-- Viral events (public insert for tracking)
alter table public.viral_events enable row level security;
create policy "Anyone can insert viral events" on public.viral_events
  for insert with check (true);
