import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export function loader() {
  return { renderedAt: new Date().toISOString() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>React Router on OpsCrew</h1>
      <p>Rendered on the server at {loaderData.renderedAt}.</p>
    </main>
  );
}
