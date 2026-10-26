import { createClient } from "@supabase/supabase-js";

// These come from .env.local (see .env.local.example). The URL and
// publishable key are both meant to be visible in client-side code -- they
// identify which Supabase project to talk to, not a secret that grants
// access on their own. What actually controls who can read/write what is
// the Row Level Security (RLS) policies we set up in the database itself.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    "Missing Supabase environment variables. Copy .env.local.example to .env.local and fill in your project's URL and publishable key."
  );
}

// One shared client for the whole app. It automatically keeps track of
// whether someone is signed in (storing the session in the browser) and
// attaches that to every request, which is what lets our database's RLS
// policies know "who is asking."
export const supabase = createClient(supabaseUrl, supabasePublishableKey);
