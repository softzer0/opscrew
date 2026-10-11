import { supabase } from "./integrations/supabase/client";

export default function App() {
  if (import.meta.env.DEV) console.log("dev mode", supabase);
  return <h1>Hello</h1>;
}
