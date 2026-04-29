# Supabase & Twilio Deployment Guide (Presentation Ready)

Because the raw SQL files are not currently tracking in the root repository, I have regenerated the entire unified schema and Edge Function architecture for your presentation. You can copy and paste these directly into your Supabase Dashboard to instantly rebuild the backend.

---

## 1. Supabase SQL Schema (Copy into SQL Editor)

This SQL script handles three things:
1. Creating a `profiles` table that automatically links to Supabase Phone Auth.
2. Creating an `outbound_calls` table to queue daily AI coaching calls.
3. Enabling `pg_cron` and `pg_net` to automatically trigger your Edge Function on a schedule without manual intervention.

```sql
-- Enable necessary extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pg_cron";
create extension if not exists "pg_net";

-- --------------------------------------------------------
-- 1. Profiles Table (Linked to Phone Auth)
-- --------------------------------------------------------
create table public.profiles (
  id uuid references auth.users on delete cascade not null primary key,
  phone_number text unique,
  display_name text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Turn on Row Level Security
alter table public.profiles enable row level security;

-- Users can only read and update their own profiles
create policy "Users can view own profile" 
  on public.profiles for select using (auth.uid() = id);

create policy "Users can update own profile" 
  on public.profiles for update using (auth.uid() = id);

-- Trigger: Automatically insert profile when a new user signs up via Twilio OTP
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, phone_number)
  values (new.id, new.phone);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- --------------------------------------------------------
-- 2. Call Scheduling Table 
-- --------------------------------------------------------
create table public.outbound_calls (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  phone_number text not null,
  scheduled_for timestamp with time zone not null,
  status text default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.outbound_calls enable row level security;
create policy "Users can view own scheduled calls" 
  on public.outbound_calls for select using (auth.uid() = user_id);


-- --------------------------------------------------------
-- 3. pg_cron Setup: Process Outbound Calls Every Minute
-- --------------------------------------------------------
-- This cron job calls an internal Supabase Edge Function to hit Twilio's API
select cron.schedule(
  'process-outbound-calls',
  '* * * * *', -- Every minute
  $$
    select net.http_post(
      url:='https://your-project-ref.supabase.co/functions/v1/twilio-outbound-caller',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb
    );
  $$
);
```

---

## 2. Supabase Edge Function (`twilio-outbound-caller/index.ts`)

This function executes the actual Twilio SIP call when triggered by the `pg_cron` schedule. 

Create a new edge function in your terminal: `supabase functions new twilio-outbound-caller`. Then paste this code into `index.ts`.

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER')!;

// The deployed FastAPI URL that returns TwiML instructions for Eva
const EVA_TWIML_URL = "https://your-fastapi-server.com/api/twiml"; 

serve(async (req) => {
  // 1. Initialize Supabase Admin client
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  // 2. Fetch all missing calls that are ready to trigger
  const { data: calls, error } = await supabaseAdmin
    .from('outbound_calls')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .limit(10);

  if (error || !calls || calls.length === 0) {
    return new Response(JSON.stringify({ message: "No calls pending" }), { status: 200 })
  }

  // 3. Trigger Twilio Calls and update status
  for (const call of calls) {
    // Mark as processing
    await supabaseAdmin.from('outbound_calls').update({ status: 'processing' }).eq('id', call.id);

    try {
      const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
      const form = new URLSearchParams({
        To: call.phone_number,
        From: TWILIO_PHONE_NUMBER,
        Url: EVA_TWIML_URL, // Twilio hits this URL to know what to say (connects to LiveKit SIP)
      });

      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString()
      });

      if (!res.ok) throw new Error("Twilio API failed");
      
      // Mark successful
      await supabaseAdmin.from('outbound_calls').update({ status: 'completed' }).eq('id', call.id);

    } catch (err) {
      // Mark failed for retry later
      await supabaseAdmin.from('outbound_calls').update({ status: 'failed' }).eq('id', call.id);
    }
  }

  return new Response(JSON.stringify({ processed: calls.length }), { status: 200, headers: { "Content-Type": "application/json" } })
})
```

---

## 3. Configuration Step-by-Step for the Presentation

If they ask how the authentication and SIP integration structurally works, you can explain the pipeline in these exact 3 steps:

### A. Authentication (Twilio OTP + Supabase Auth)
1. In the Supabase Dashboard, go to **Authentication > Providers > Phone**.
2. Enable "Phone" and paste your **Twilio Account SID** and **Auth Token**.
3. *Note: You do not need custom code to verify OTPs. The Supabase JS Client handles it securely out of the box (`supabase.auth.signInWithOtp({ phone })`).*

### B. Automated Coaching Calls (`pg_cron`)
1. A user tells Eva "Call me tomorrow at 9 AM". 
2. The LiveKit agent parses this and inserts a row into `outbound_calls` via the Supabase Client.
3. Every 60 seconds, `pg_cron` in the Supabase Database secretly checks if the clock has hit 9 AM. 
4. If yes, it pings our Edge Function which orders Twilio to dial the user's phone.

### C. Live Coaching Session (Twilio SIP + LiveKit)
1. Twilio calls the User. The User picks up.
2. Twilio Immediately hits the `EVA_TWIML_URL` (our FastAPI Backend) asking "What do I say/do?"
3. FastAPI responds with TwiML `<Connect><Sip>sip:room-id@your-livekit.cloud</Sip></Connect>`.
4. Twilio bridges the cellular phone call directly into the **LiveKit WSS Room**. Eva wakes up instantly and starts talking to them over the phone lines!
