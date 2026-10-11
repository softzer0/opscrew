import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export default function App() {
  const [habits, setHabits] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    supabase.from("habits").select("id, title").then(({ data }) => setHabits(data ?? []));
  }, []);
  return (
    <main>
      <h1>My habits</h1>
      <ul>{habits.map((h) => <li key={h.id}>{h.title}</li>)}</ul>
    </main>
  );
}
