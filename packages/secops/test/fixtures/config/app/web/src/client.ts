export const config = {
  url: import.meta.env.VITE_SUPABASE_URL,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  stripe: import.meta.env.VITE_STRIPE_SECRET_KEY,
  signing: process.env.REACT_APP_PRIVATE_KEY,
  again: import.meta.env.VITE_STRIPE_SECRET_KEY,
};
