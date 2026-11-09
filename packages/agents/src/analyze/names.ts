/** Display names of detected frameworks, apart from the analysis so the designer can use them. */
const FRAMEWORK_NAMES: Record<string, string> = {
  next: "Next.js",
  nuxt: "Nuxt",
  remix: "Remix",
  "react-router": "React Router",
  sveltekit: "SvelteKit",
  astro: "Astro",
  vite: "Vite",
  "create-react-app": "Create React App",
  angular: "Angular",
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  solid: "Solid",
  preact: "Preact",
  express: "Express",
  fastify: "Fastify",
  nestjs: "NestJS",
  hono: "Hono",
  koa: "Koa",
  fastapi: "FastAPI",
  flask: "Flask",
  django: "Django",
  rails: "Rails",
  laravel: "Laravel",
};

/** Display name of a detected framework (`next` → `Next.js`). */
export function frameworkName(name: string): string {
  return FRAMEWORK_NAMES[name] ?? name;
}
